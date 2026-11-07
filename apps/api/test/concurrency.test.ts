import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assertNoDoubleBooking, post, resetAndSeed, startTestEnv, tomorrowAt, type TestEnv } from './helpers.js';

/**
 * The headline test: many guests hit POST /api/holds at the same instant, over real HTTP,
 * against a real Postgres with a 40-connection pool. No mocks, no locks in Node.
 */
let env: TestEnv;
beforeAll(async () => {
  env = await startTestEnv();
});
afterAll(async () => env.close());
beforeEach(async () => {
  await resetAndSeed(env.db);
});

const statuses = (results: { status: number }[]) =>
  results.reduce<Record<number, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});

describe('concurrent holds against real Postgres', () => {
  it('one-on-one: 50 simultaneous holds on the same slot -> exactly 1 wins', async () => {
    const start = await tomorrowAt(env.db, '10:00');
    const results = await Promise.all(
      Array.from({ length: 50 }, () => post(env.baseUrl, '/api/holds', { host: 'tester', slug: 'call', start })),
    );
    console.log('one-on-one, 50 concurrent holds:', statuses(results));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(49);
    const { rows } = await env.db.query(`SELECT count(*)::int AS n FROM bookings WHERE status = 'held'`);
    expect(rows[0].n).toBe(1);
    expect(await assertNoDoubleBooking(env.db)).toEqual({ overlapping: 0, overfullSessions: 0 });
  });

  it('group session: 50 simultaneous holds on a capacity-3 slot -> exactly 3 win', async () => {
    const start = await tomorrowAt(env.db, '11:00');
    const results = await Promise.all(
      Array.from({ length: 50 }, () => post(env.baseUrl, '/api/holds', { host: 'tester', slug: 'workshop', start })),
    );
    console.log('group capacity 3, 50 concurrent holds:', statuses(results));
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(results.filter((r) => r.status === 409)).toHaveLength(47);
    expect(await assertNoDoubleBooking(env.db)).toEqual({ overlapping: 0, overfullSessions: 0 });
  });

  it('cross-event-type: the same host cannot be in a call and a workshop at overlapping times', async () => {
    // call 10:00–10:30 (+10 min buffer) and workshop 10:00–11:00 overlap, plus call 10:30 overlaps
    // the workshop too. 60 guests race across three different sessions.
    const [call10, call1030, ws10] = await Promise.all([
      tomorrowAt(env.db, '10:00'),
      tomorrowAt(env.db, '10:30'),
      tomorrowAt(env.db, '10:00'),
    ]);
    const requests = Array.from({ length: 60 }, (_, i) => {
      const pick = i % 3;
      if (pick === 0) return { host: 'tester', slug: 'call', start: call10 };
      if (pick === 1) return { host: 'tester', slug: 'call', start: call1030 };
      return { host: 'tester', slug: 'workshop', start: ws10 };
    });
    const results = await Promise.all(requests.map((r) => post(env.baseUrl, '/api/holds', r)));
    console.log('cross-event-type race, 60 holds over 3 overlapping sessions:', statuses(results));

    expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(true);
    // Whatever the interleaving, the database never holds an overlap between different sessions.
    expect(await assertNoDoubleBooking(env.db)).toEqual({ overlapping: 0, overfullSessions: 0 });
    const winners = results.filter((r) => r.status === 201);
    // Either the workshop won (up to 3 seats) or calls won (10:00 and 10:30 overlap via buffer -> at most 1).
    const workshopWins = winners.filter((w) => w.body.eventType.slug === 'workshop').length;
    const callWins = winners.length - workshopWins;
    expect(workshopWins === 0 || callWins === 0).toBe(true);
    expect(callWins).toBeLessThanOrEqual(1);
    expect(workshopWins).toBeLessThanOrEqual(3);
  });
});
