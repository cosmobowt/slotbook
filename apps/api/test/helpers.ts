import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createPool, type Db } from '../src/db.js';
import { migrate } from '../src/migrate.js';

export const TEST_DB_URL =
  process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/slotbook_test';

export interface TestEnv {
  db: Db;
  app: FastifyInstance;
  baseUrl: string;
  close: () => Promise<void>;
}

/** A real HTTP server on a random port, backed by a real Postgres pool of 40 connections. */
export async function startTestEnv(): Promise<TestEnv> {
  const db = createPool(TEST_DB_URL, 40);
  await migrate(db, () => {});
  const app = buildApp(db);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  return {
    db,
    app,
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      await app.close();
      await db.end();
    },
  };
}

/**
 * Wipe data and create a host in UTC, open 09:00–17:00 every day, with:
 *   one-on-one  "call"     30 min, capacity 1, 10 min buffer after
 *   group       "workshop" 60 min, capacity 3
 * Minimum notice 0 so tests can book "tomorrow".
 */
export async function resetAndSeed(db: Db) {
  await db.query(`TRUNCATE notifications, idempotency_keys, bookings, slot_sessions, date_overrides,
                  availability_rules, event_types, host_sessions, hosts CASCADE`);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO hosts (username, display_name, timezone, password_hash) VALUES ('tester', 'Tester', 'UTC', 'x:x') RETURNING id`,
  );
  const hostId = rows[0].id;
  await db.query(
    `INSERT INTO event_types (host_id, slug, name, duration_min, capacity, buffer_after_min, min_notice_min, horizon_days)
     VALUES ($1, 'call', 'Call', 30, 1, 10, 0, 30), ($1, 'workshop', 'Workshop', 60, 3, 0, 0, 30)`,
    [hostId],
  );
  for (let d = 1; d <= 7; d++) {
    await db.query(`INSERT INTO availability_rules (host_id, weekday, start_time, end_time) VALUES ($1, $2, '09:00', '17:00')`, [
      hostId,
      d,
    ]);
  }
  return hostId;
}

/** "Tomorrow at HH:MM UTC" by the database clock. */
export async function tomorrowAt(db: Db, hhmm: string): Promise<string> {
  const { rows } = await db.query<{ t: Date }>(
    `SELECT (date_trunc('day', now() AT TIME ZONE 'UTC') + interval '1 day' + $1::time) AT TIME ZONE 'UTC' AS t`,
    [hhmm],
  );
  return rows[0].t.toISOString();
}

export async function post(baseUrl: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(baseUrl + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: (await res.json()) as any };
}

/**
 * The invariant, checked directly in SQL: among active bookings of a host, any two that
 * overlap must belong to the same session, and no session exceeds its capacity.
 */
export async function assertNoDoubleBooking(db: Db) {
  const overlaps = await db.query(`
    SELECT a.id, b.id FROM bookings a JOIN bookings b
      ON a.host_id = b.host_id AND a.id < b.id AND a.blocked && b.blocked AND a.session_id <> b.session_id
    WHERE a.status IN ('held','confirmed') AND b.status IN ('held','confirmed')`);
  const overfull = await db.query(`
    SELECT s.id FROM slot_sessions s JOIN event_types e ON e.id = s.event_type_id
    JOIN bookings b ON b.session_id = s.id AND b.status IN ('held','confirmed')
    GROUP BY s.id, e.capacity HAVING count(*) > e.capacity`);
  return { overlapping: overlaps.rowCount, overfullSessions: overfull.rowCount };
}
