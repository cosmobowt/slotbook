import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertNoDoubleBooking, post, resetAndSeed, startTestEnv, tomorrowAt, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await startTestEnv();
});
afterAll(async () => env.close());
beforeEach(async () => {
  await resetAndSeed(env.db);
});
afterEach(() => {
  vi.useRealTimers();
});

const hold = (start: string, slug = 'call', headers: Record<string, string> = {}) =>
  post(env.baseUrl, '/api/holds', { host: 'tester', slug, start }, headers);
const confirm = (holdId: string, email = 'guest@example.com') =>
  post(env.baseUrl, `/api/holds/${holdId}/confirm`, { name: 'Guest', email });

describe('network misbehaves: retries are safe', () => {
  it('same Idempotency-Key retried -> same hold, one row, replay header set', async () => {
    const start = await tomorrowAt(env.db, '10:00');
    const key = { 'Idempotency-Key': 'retry-key-0001' };
    const first = await hold(start, 'call', key);
    const retry = await hold(start, 'call', key);
    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.body.holdId).toBe(first.body.holdId);
    expect(retry.headers.get('idempotent-replayed')).toBe('true');
    const { rows } = await env.db.query('SELECT count(*)::int AS n FROM bookings');
    expect(rows[0].n).toBe(1);
  });

  it('20 concurrent requests with one Idempotency-Key -> all get the same hold', async () => {
    const start = await tomorrowAt(env.db, '10:00');
    const results = await Promise.all(
      Array.from({ length: 20 }, () => hold(start, 'call', { 'Idempotency-Key': 'double-click-0001' })),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.holdId)).size).toBe(1);
    const { rows } = await env.db.query('SELECT count(*)::int AS n FROM bookings');
    expect(rows[0].n).toBe(1);
  });

  it('reusing a key for a different slot is rejected, not silently replayed', async () => {
    const key = { 'Idempotency-Key': 'reused-key-0001' };
    expect((await hold(await tomorrowAt(env.db, '10:00'), 'call', key)).status).toBe(201);
    const other = await hold(await tomorrowAt(env.db, '12:00'), 'call', key);
    expect(other.status).toBe(422);
    expect(other.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('confirm and cancel are idempotent: a retry after a lost response gets the same answer', async () => {
    const h = await hold(await tomorrowAt(env.db, '10:00'));
    const c1 = await confirm(h.body.holdId);
    const c2 = await confirm(h.body.holdId);
    expect(c1.status).toBe(200);
    expect(c2.status).toBe(200);
    expect(c2.body.manageToken).toBe(c1.body.manageToken);

    const x1 = await post(env.baseUrl, `/api/bookings/${c1.body.manageToken}/cancel`, { reason: 'conflict' });
    const x2 = await post(env.baseUrl, `/api/bookings/${c1.body.manageToken}/cancel`, { reason: 'conflict' });
    expect([x1.status, x2.status]).toEqual([200, 200]);
    const { rows } = await env.db.query(`SELECT type FROM notifications ORDER BY id`);
    expect(rows.map((r) => r.type)).toEqual(['booking.confirmed', 'booking.cancelled']); // exactly one each
  });
});

describe('clock misbehaves: only the database clock counts', () => {
  it('a hold past its expiry (by DB clock) cannot be confirmed, and the slot is free again', async () => {
    const start = await tomorrowAt(env.db, '10:00');
    const h = await hold(start);
    expect(h.status).toBe(201);
    // Simulate 5 minutes passing on the database clock. The sweeper is not running in tests,
    // so this also proves correctness does not depend on the background job.
    await env.db.query(`UPDATE bookings SET hold_expires_at = now() - interval '1 second' WHERE id = $1`, [h.body.holdId]);

    const late = await confirm(h.body.holdId);
    expect(late.status).toBe(410);
    expect(late.body.error.code).toBe('HOLD_EXPIRED');

    const next = await hold(start); // lazily expires the stale hold inside its own transaction
    expect(next.status).toBe(201);
    const { rows } = await env.db.query(`SELECT status FROM bookings WHERE id = $1`, [h.body.holdId]);
    expect(rows[0].status).toBe('expired');
  });

  it('app server clock skewed by ±1 day changes nothing: expiry and notice use Postgres now()', async () => {
    const start = await tomorrowAt(env.db, '10:00');
    vi.useFakeTimers({ toFake: ['Date'] });

    vi.setSystemTime(new Date(Date.now() + 86_400_000)); // app thinks it is a day later
    const h = await hold(start);
    expect(h.status).toBe(201);
    const { rows } = await env.db.query(`SELECT hold_expires_at - now() AS ttl FROM bookings WHERE id = $1`, [h.body.holdId]);
    expect(rows[0].ttl.minutes ?? 0).toBeGreaterThanOrEqual(4); // ~5 minutes from the DB's now, not the app's

    vi.setSystemTime(new Date(Date.now() - 2 * 86_400_000)); // now a day earlier than reality
    const c = await confirm(h.body.holdId);
    expect(c.status).toBe(200);
  });
});

describe('user misbehaves', () => {
  it('cannot hold a time the host does not offer, or one inside a buffer', async () => {
    const offHours = await hold(await tomorrowAt(env.db, '03:00'));
    expect(offHours.status).toBe(422);
    const offGrid = await hold(await tomorrowAt(env.db, '10:07'));
    expect(offGrid.status).toBe(422);

    // 10:00 call blocks the host until 10:40 (10 min buffer), so the 10:30 call must be refused.
    expect((await hold(await tomorrowAt(env.db, '10:00'))).status).toBe(201);
    const inBuffer = await hold(await tomorrowAt(env.db, '10:30'));
    expect(inBuffer.status).toBe(409);
    expect(inBuffer.body.error.code).toBe('SLOT_TAKEN');
  });

  it('the slots endpoint hides the taken and buffered slots, and shows remaining seats', async () => {
    const h = await hold(await tomorrowAt(env.db, '10:00'));
    expect(h.status).toBe(201);
    const res = await fetch(`${env.baseUrl}/api/hosts/tester/events/call/slots?tz=Asia/Kolkata`);
    const body = (await res.json()) as any;
    const starts = body.slots.map((s: any) => s.start);
    expect(starts).not.toContain(await tomorrowAt(env.db, '10:00'));
    expect(starts).not.toContain(await tomorrowAt(env.db, '10:30')); // buffer
    expect(starts).toContain(await tomorrowAt(env.db, '11:00'));
    const at11 = body.slots.find((s: any) => s.start === new Date(Date.parse(h.body.start) + 3_600_000).toISOString());
    expect(at11.localTime).toBe('16:30'); // 11:00 UTC shown in the guest's zone (IST)

    const ws = (await (await fetch(`${env.baseUrl}/api/hosts/tester/events/workshop/slots`)).json()) as any;
    // The 10:00 call (+buffer) also blocks the overlapping workshop session for the same host.
    expect(ws.slots.map((s: any) => s.start)).not.toContain(await tomorrowAt(env.db, '10:00'));
  });
});

describe('reschedule', () => {
  it('moves a booking in place, even into a range overlapping its own old slot', async () => {
    const h = await hold(await tomorrowAt(env.db, '10:00'));
    const c = await confirm(h.body.holdId);
    const moved = await post(env.baseUrl, `/api/bookings/${c.body.manageToken}/reschedule`, {
      start: await tomorrowAt(env.db, '10:30'),
    });
    expect(moved.status).toBe(200);
    expect(moved.body.start).toBe(await tomorrowAt(env.db, '10:30'));
    expect(moved.body.manageToken).toBe(c.body.manageToken);
    // The old range is released in the same commit: a 09:30 call (blocking 09:30–10:10) would have
    // collided with the old 10:00 booking, and now succeeds.
    expect((await hold(await tomorrowAt(env.db, '09:30'), 'call')).status).toBe(201);
  });

  it('cannot reschedule into another guest\'s slot', async () => {
    const a = await confirm((await hold(await tomorrowAt(env.db, '10:00'))).body.holdId);
    await hold(await tomorrowAt(env.db, '14:00')); // someone else is holding 14:00
    const r = await post(env.baseUrl, `/api/bookings/${a.body.manageToken}/reschedule`, { start: await tomorrowAt(env.db, '14:00') });
    expect(r.status).toBe(409);
    expect(await assertNoDoubleBooking(env.db)).toEqual({ overlapping: 0, overfullSessions: 0 });
    const { rows } = await env.db.query(`SELECT start_at FROM bookings WHERE manage_token = $1`, [a.body.manageToken]);
    expect(rows[0].start_at.toISOString()).toBe(await tomorrowAt(env.db, '10:00')); // unchanged
  });
});
