import type { Db } from '../db.js';

export interface OutboxRow {
  id: number;
  booking_id: string;
  type: string;
  payload: unknown;
  created_at: Date;
}

export type Deliver = (n: OutboxRow) => Promise<void>;

/** POST to NOTIFY_WEBHOOK_URL when set (a local receiver is enough); otherwise a structured log line. */
export function defaultDeliver(log: (obj: object, msg: string) => void): Deliver {
  const url = process.env.NOTIFY_WEBHOOK_URL;
  return async (n) => {
    if (!url) {
      log({ notification: { id: n.id, type: n.type, bookingId: n.booking_id } }, 'notification');
      return;
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `notification-${n.id}` },
      body: JSON.stringify({ id: n.id, type: n.type, payload: n.payload, createdAt: n.created_at }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`webhook responded ${res.status}`);
  };
}

/**
 * Drain the outbox. Rows are claimed with FOR UPDATE SKIP LOCKED, so several app instances
 * can run this at once without delivering the same row twice concurrently. On a failure we
 * stop, mark what succeeded, and leave the rest for the next tick: at-least-once delivery,
 * and receivers deduplicate on the notification id (sent as idempotency-key).
 */
export async function dispatchNotifications(db: Db, deliver: Deliver, batch = 50): Promise<{ delivered: number; failed: boolean }> {
  const client = await db.connect();
  let delivered: number[] = [];
  let failed = false;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<OutboxRow>(
      `SELECT id, booking_id, type, payload, created_at FROM notifications
       WHERE delivered_at IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [batch],
    );
    for (const n of rows) {
      try {
        await deliver(n);
        delivered.push(n.id);
      } catch {
        failed = true;
        break; // keep order: don't deliver later events of a booking before an earlier one
      }
    }
    if (delivered.length) {
      await client.query('UPDATE notifications SET delivered_at = now() WHERE id = ANY($1::bigint[])', [delivered]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    delivered = [];
    throw err;
  } finally {
    client.release();
  }
  return { delivered: delivered.length, failed };
}
