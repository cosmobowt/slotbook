import { createHash, randomBytes } from 'node:crypto';
import { PG, pgCode, withTxRetry, type Db, type Tx } from '../db.js';
import { errors } from '../lib/errors.js';
import { blockedRange, candidateStarts, type EventTypeConfig } from './slots.js';

/**
 * The booking lifecycle: held -> confirmed -> (cancelled), and held -> expired.
 *
 * Where correctness comes from (none of it from application-side checks):
 *  1. no_double_booking exclusion constraint  — no overlapping active bookings for a host
 *  2. SELECT ... FOR UPDATE on the slot_sessions row — seats in a group session are counted
 *     while every other booker of that session waits
 *  3. Postgres now()  — the only clock; hold expiry never reads the app server's or browser's time
 *  4. Idempotency key claimed in the same transaction as the hold
 *  5. Notifications written in the same transaction (outbox), so they exist iff the change committed
 */

export const HOLD_TTL_SECONDS = Number(process.env.HOLD_TTL_SECONDS ?? 300);

interface EventRow {
  id: string;
  host_id: string;
  host_username: string;
  host_timezone: string;
  slug: string;
  name: string;
  duration_min: number;
  capacity: number;
  buffer_before_min: number;
  buffer_after_min: number;
  min_notice_min: number;
  horizon_days: number;
}

export function toConfig(e: EventRow): EventTypeConfig {
  return {
    id: e.id,
    durationMin: e.duration_min,
    capacity: e.capacity,
    bufferBeforeMin: e.buffer_before_min,
    bufferAfterMin: e.buffer_after_min,
    minNoticeMin: e.min_notice_min,
    horizonDays: e.horizon_days,
  };
}

const EVENT_SELECT = `
  SELECT e.*, h.username AS host_username, h.timezone AS host_timezone
  FROM event_types e JOIN hosts h ON h.id = e.host_id`;

export async function loadEventBySlug(q: Db | Tx, host: string, slug: string): Promise<EventRow> {
  const { rows } = await q.query<EventRow>(`${EVENT_SELECT} WHERE h.username = $1 AND e.slug = $2 AND e.active`, [host, slug]);
  if (!rows[0]) throw errors.notFound('Event type');
  return rows[0];
}

async function loadEventById(q: Db | Tx, id: string): Promise<EventRow> {
  const { rows } = await q.query<EventRow>(`${EVENT_SELECT} WHERE e.id = $1`, [id]);
  if (!rows[0]) throw errors.notFound('Event type');
  return rows[0];
}

export async function loadAvailability(q: Db | Tx, hostId: string) {
  const [rules, overrides] = await Promise.all([
    q.query<{ weekday: number; start_time: string; end_time: string }>(
      'SELECT weekday, start_time, end_time FROM availability_rules WHERE host_id = $1 ORDER BY weekday, start_time',
      [hostId],
    ),
    q.query<{ on_date: string; start_time: string | null; end_time: string | null }>(
      'SELECT on_date, start_time, end_time FROM date_overrides WHERE host_id = $1 ORDER BY on_date, start_time',
      [hostId],
    ),
  ]);
  return {
    rules: rules.rows.map((r) => ({ weekday: r.weekday, start: r.start_time, end: r.end_time })),
    overrides: overrides.rows.map((o) => ({ date: o.on_date, start: o.start_time, end: o.end_time })),
  };
}

export async function dbNow(q: Db | Tx): Promise<Date> {
  const { rows } = await q.query<{ now: Date }>('SELECT now() AS now');
  return rows[0].now;
}

/** The requested start must be one the host's rules actually offer, judged by the DB clock. */
async function assertBookableStart(tx: Tx, ev: EventRow, start: Date, now: Date): Promise<Date> {
  if (Number.isNaN(start.getTime())) throw errors.slotInvalid('start is not a valid timestamp');
  const { rules, overrides } = await loadAvailability(tx, ev.host_id);
  const match = candidateStarts({
    eventType: toConfig(ev),
    hostZone: ev.host_timezone,
    rules,
    overrides,
    now,
    from: start,
    to: new Date(start.getTime() + 1),
  }).find((c) => c.start.getTime() === start.getTime());
  if (!match) throw errors.slotInvalid('That time is not offered (outside hours, inside minimum notice, or past the horizon)');
  return match.end;
}

/** Expire stale holds that would block this range. Needed because a constraint's WHERE can't use now(). */
async function expireStaleHoldsOverlapping(tx: Tx, hostId: string, blocked: { start: Date; end: Date }) {
  await tx.query(
    `UPDATE bookings SET status = 'expired'
     WHERE host_id = $1 AND status = 'held' AND hold_expires_at <= now()
       AND blocked && tstzrange($2, $3, '[)')`,
    [hostId, blocked.start, blocked.end],
  );
}

/** Upsert the session row and lock it. Every booker of this session queues here. */
async function lockSession(tx: Tx, eventTypeId: string, start: Date): Promise<string> {
  await tx.query(
    'INSERT INTO slot_sessions (event_type_id, start_at) VALUES ($1, $2) ON CONFLICT (event_type_id, start_at) DO NOTHING',
    [eventTypeId, start],
  );
  const { rows } = await tx.query<{ id: string }>(
    'SELECT id FROM slot_sessions WHERE event_type_id = $1 AND start_at = $2 FOR UPDATE',
    [eventTypeId, start],
  );
  return rows[0].id;
}

async function seatsTaken(tx: Tx, sessionId: string, excludeBookingId?: string): Promise<number> {
  const { rows } = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM bookings
     WHERE session_id = $1 AND status IN ('held', 'confirmed') AND id IS DISTINCT FROM $2`,
    [sessionId, excludeBookingId ?? null],
  );
  return rows[0].n;
}

function translateConstraintError(err: unknown): never {
  if (pgCode(err) === PG.EXCLUSION_VIOLATION) throw errors.slotTaken();
  throw err;
}

// ─── Hold ───────────────────────────────────────────────────────────────────

export interface HoldRequest {
  host: string;
  slug: string;
  start: string; // ISO instant
}

export interface ApiResult {
  status: number;
  body: unknown;
  replayed?: boolean;
}

export async function createHold(db: Db, req: HoldRequest, idempotencyKey?: string): Promise<ApiResult> {
  const requestHash = createHash('sha256').update(JSON.stringify([req.host, req.slug, req.start])).digest('hex');

  return withTxRetry(db, async (tx) => {
    if (idempotencyKey) {
      // Claim the key. A concurrent duplicate blocks on the primary key until we commit,
      // then sees our stored response. If we roll back, the key is released with us.
      const claimed = await tx.query(
        `INSERT INTO idempotency_keys (scope, key, request_hash, response_status, response_body)
         VALUES ('holds', $1, $2, 0, '{}') ON CONFLICT (scope, key) DO NOTHING RETURNING key`,
        [idempotencyKey, requestHash],
      );
      if (claimed.rowCount === 0) {
        const { rows } = await tx.query<{ request_hash: string; response_status: number; response_body: unknown }>(
          `SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE scope = 'holds' AND key = $1`,
          [idempotencyKey],
        );
        if (rows[0].request_hash !== requestHash) throw errors.idempotencyMismatch();
        return { status: rows[0].response_status, body: rows[0].response_body, replayed: true };
      }
    }

    const now = await dbNow(tx);
    const ev = await loadEventBySlug(tx, req.host, req.slug);
    const start = new Date(req.start);
    const end = await assertBookableStart(tx, ev, start, now);
    const blocked = blockedRange(toConfig(ev), start, end);

    await expireStaleHoldsOverlapping(tx, ev.host_id, blocked);
    const sessionId = await lockSession(tx, ev.id, start);
    if ((await seatsTaken(tx, sessionId)) >= ev.capacity) throw errors.slotFull();

    let hold: { id: string; hold_expires_at: Date };
    try {
      const { rows } = await tx.query<{ id: string; hold_expires_at: Date }>(
        `INSERT INTO bookings (host_id, event_type_id, session_id, start_at, end_at, blocked, status, hold_expires_at)
         VALUES ($1, $2, $3, $4, $5, tstzrange($6, $7, '[)'), 'held', now() + make_interval(secs => $8))
         RETURNING id, hold_expires_at`,
        [ev.host_id, ev.id, sessionId, start, end, blocked.start, blocked.end, HOLD_TTL_SECONDS],
      );
      hold = rows[0];
    } catch (err) {
      translateConstraintError(err);
    }

    const body = {
      holdId: hold.id,
      eventType: { host: ev.host_username, slug: ev.slug, name: ev.name },
      start: start.toISOString(),
      end: end.toISOString(),
      expiresAt: hold.hold_expires_at.toISOString(),
    };
    if (idempotencyKey) {
      await tx.query(
        `UPDATE idempotency_keys SET response_status = 201, response_body = $2 WHERE scope = 'holds' AND key = $1`,
        [idempotencyKey, body],
      );
    }
    return { status: 201, body };
  });
}

// ─── Confirm ────────────────────────────────────────────────────────────────

interface BookingRow {
  id: string;
  host_id: string;
  event_type_id: string;
  session_id: string;
  start_at: Date;
  end_at: Date;
  status: 'held' | 'confirmed' | 'cancelled' | 'expired';
  hold_expires_at: Date | null;
  guest_name: string | null;
  guest_email: string | null;
  manage_token: string | null;
  cancel_reason: string | null;
}

async function notify(tx: Tx, bookingId: string, type: string, payload: Record<string, unknown>) {
  await tx.query('INSERT INTO notifications (booking_id, type, payload) VALUES ($1, $2, $3)', [bookingId, type, payload]);
}

async function bookingView(q: Db | Tx, b: BookingRow) {
  const ev = await loadEventById(q, b.event_type_id);
  return {
    id: b.id,
    status: b.status,
    start: b.start_at.toISOString(),
    end: b.end_at.toISOString(),
    guestName: b.guest_name,
    guestEmail: b.guest_email,
    manageToken: b.manage_token,
    cancelReason: b.cancel_reason,
    eventType: { host: ev.host_username, slug: ev.slug, name: ev.name, durationMin: ev.duration_min, hostTimezone: ev.host_timezone },
  };
}

export async function confirmHold(db: Db, holdId: string, guest: { name: string; email: string }) {
  return withTxRetry(db, async (tx) => {
    // One atomic statement: succeeds only if the hold is still alive *by the database clock*.
    const token = randomBytes(24).toString('base64url');
    let rows: BookingRow[];
    try {
      ({ rows } = await tx.query<BookingRow>(
        `UPDATE bookings
         SET status = 'confirmed', guest_name = $2, guest_email = $3, manage_token = $4, confirmed_at = now()
         WHERE id = $1 AND status = 'held' AND hold_expires_at > now()
         RETURNING *`,
        [holdId, guest.name, guest.email, token],
      ));
    } catch (err) {
      // Per-guest limit (migration 002): the unique index rejects a second active booking for this email.
      if (pgCode(err) === PG.UNIQUE_VIOLATION && (err as { constraint?: string }).constraint === 'one_active_booking_per_guest') {
        throw errors.guestLimit();
      }
      throw err;
    }
    if (rows[0]) {
      const view = await bookingView(tx, rows[0]);
      await notify(tx, rows[0].id, 'booking.confirmed', { ...view, manageToken: undefined });
      return view;
    }

    // Nothing updated: find out why, and answer retries idempotently.
    const existing = await tx.query<BookingRow>('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [holdId]);
    const b = existing.rows[0];
    if (!b) throw errors.notFound('Hold');
    if (b.status === 'confirmed') return bookingView(tx, b); // retry after a lost response
    if (b.status === 'cancelled') throw errors.bookingNotActive();
    throw errors.holdExpired(); // held-but-past-expiry or already expired; the sweeper/lazy expiry flips the status

  });
}

// ─── Manage: view, reschedule, cancel ───────────────────────────────────────

export async function getBookingByToken(db: Db, token: string) {
  const { rows } = await db.query<BookingRow>('SELECT * FROM bookings WHERE manage_token = $1', [token]);
  if (!rows[0]) throw errors.notFound('Booking');
  return bookingView(db, rows[0]);
}

export async function rescheduleBooking(db: Db, token: string, newStartIso: string) {
  return withTxRetry(db, async (tx) => {
    const { rows } = await tx.query<BookingRow>('SELECT * FROM bookings WHERE manage_token = $1 FOR UPDATE', [token]);
    const b = rows[0];
    if (!b) throw errors.notFound('Booking');
    if (b.status !== 'confirmed') throw errors.bookingNotActive();

    const newStart = new Date(newStartIso);
    if (newStart.getTime() === b.start_at.getTime()) return bookingView(tx, b); // retried request: already there

    const now = await dbNow(tx);
    const ev = await loadEventById(tx, b.event_type_id);
    const newEnd = await assertBookableStart(tx, ev, newStart, now);
    const blocked = blockedRange(toConfig(ev), newStart, newEnd);

    await expireStaleHoldsOverlapping(tx, ev.host_id, blocked);
    const sessionId = await lockSession(tx, ev.id, newStart);
    if ((await seatsTaken(tx, sessionId, b.id)) >= ev.capacity) throw errors.slotFull();

    // Move the row in place: the constraint re-checks the new range against every *other*
    // active booking, so the booking never conflicts with its own old slot, and the guest
    // keeps the same manage link. Old slot is freed in the same commit.
    let updated: BookingRow;
    try {
      const res = await tx.query<BookingRow>(
        `UPDATE bookings SET session_id = $2, start_at = $3, end_at = $4, blocked = tstzrange($5, $6, '[)')
         WHERE id = $1 RETURNING *`,
        [b.id, sessionId, newStart, newEnd, blocked.start, blocked.end],
      );
      updated = res.rows[0];
    } catch (err) {
      translateConstraintError(err);
    }
    const view = await bookingView(tx, updated);
    await notify(tx, b.id, 'booking.rescheduled', {
      ...view,
      manageToken: undefined,
      previousStart: b.start_at.toISOString(),
      previousEnd: b.end_at.toISOString(),
    });
    return view;
  });
}

async function cancelWhere(db: Db, where: string, params: unknown[], reason: string | null) {
  return withTxRetry(db, async (tx) => {
    const { rows } = await tx.query<BookingRow>(
      `UPDATE bookings SET status = 'cancelled', cancel_reason = $${params.length + 1}, cancelled_at = now()
       WHERE ${where} AND status = 'confirmed' RETURNING *`,
      [...params, reason],
    );
    if (rows[0]) {
      const view = await bookingView(tx, rows[0]);
      await notify(tx, rows[0].id, 'booking.cancelled', { ...view, manageToken: undefined });
      return view;
    }
    const existing = await tx.query<BookingRow>(`SELECT * FROM bookings WHERE ${where}`, params);
    if (!existing.rows[0]) throw errors.notFound('Booking');
    if (existing.rows[0].status === 'cancelled') return bookingView(tx, existing.rows[0]); // idempotent retry
    throw errors.bookingNotActive();
  });
}

export const cancelByGuest = (db: Db, token: string, reason: string | null) =>
  cancelWhere(db, 'manage_token = $1', [token], reason);

export const cancelByHost = (db: Db, hostId: string, bookingId: string, reason: string) =>
  cancelWhere(db, 'id = $1 AND host_id = $2', [bookingId, hostId], reason);

// ─── Background sweeper ─────────────────────────────────────────────────────

/** Housekeeping only. Correctness never waits for this: holds are checked against now() inline. */
export async function expireHolds(db: Db): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE bookings SET status = 'expired' WHERE status = 'held' AND hold_expires_at <= now()`,
  );
  return rowCount ?? 0;
}
