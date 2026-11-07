import { DateTime } from 'luxon';
import type { Db } from '../db.js';
import { errors } from '../lib/errors.js';
import { dbNow, loadAvailability, loadEventBySlug, toConfig } from './bookings.js';
import { availableSlots, isValidZone } from './slots.js';

/**
 * GET slots: generated in the host's zone, returned as UTC instants plus the same
 * instant rendered in the guest's zone. The browser never does time-zone math.
 */
export async function getSlots(db: Db, host: string, slug: string, opts: { from?: string; to?: string; tz?: string }) {
  const tz = opts.tz && isValidZone(opts.tz) ? opts.tz : 'UTC';
  if (opts.tz && !isValidZone(opts.tz)) throw errors.badRequest(`Unknown time zone: ${opts.tz}`);

  const ev = await loadEventBySlug(db, host, slug);
  const now = await dbNow(db);
  // from/to accept an ISO instant or a plain date (interpreted in the guest's zone).
  const parse = (v: string | undefined, fallback: Date) => {
    if (!v) return fallback;
    const dt = /^\d{4}-\d{2}-\d{2}$/.test(v) ? DateTime.fromISO(v, { zone: tz }) : DateTime.fromISO(v, { setZone: true });
    if (!dt.isValid) throw errors.badRequest(`Invalid date: ${v}`);
    return dt.toJSDate();
  };
  const from = parse(opts.from, now);
  const to = parse(opts.to, new Date(now.getTime() + ev.horizon_days * 86_400_000));

  const { rules, overrides } = await loadAvailability(db, ev.host_id);
  // Active bookings of this host from ANY event type; expired holds are ignored by the
  // now() filter here (display), and expired for real inside the hold transaction (write).
  const busy = await db.query<{ event_type_id: string; start_at: Date; b_start: Date; b_end: Date }>(
    `SELECT event_type_id, start_at, lower(blocked) AS b_start, upper(blocked) AS b_end FROM bookings
     WHERE host_id = $1
       AND (status = 'confirmed' OR (status = 'held' AND hold_expires_at > now()))
       AND blocked && tstzrange($2::timestamptz - interval '1 day', $3::timestamptz + interval '1 day')`,
    [ev.host_id, from, to],
  );

  const slots = availableSlots({
    eventType: toConfig(ev),
    hostZone: ev.host_timezone,
    rules,
    overrides,
    now,
    from,
    to,
    busy: busy.rows.map((r) => ({ eventTypeId: r.event_type_id, start: r.start_at, blockedStart: r.b_start, blockedEnd: r.b_end })),
  });

  return {
    eventType: {
      host: ev.host_username,
      slug: ev.slug,
      name: ev.name,
      durationMin: ev.duration_min,
      capacity: ev.capacity,
      hostTimezone: ev.host_timezone,
    },
    timezone: tz,
    slots: slots.map((s) => {
      const local = DateTime.fromJSDate(s.start, { zone: tz });
      return {
        start: s.start.toISOString(),
        end: s.end.toISOString(),
        localDate: local.toISODate(),
        localTime: local.toFormat('HH:mm'),
        seatsLeft: s.seatsLeft,
      };
    }),
  };
}
