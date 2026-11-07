import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.js';

/**
 * /health and /metrics (Prometheus text format). Booking metrics come straight from the
 * database, so they are correct across any number of app instances; HTTP counters are
 * per instance, as Prometheus expects.
 */
export function opsRoutes(app: FastifyInstance, db: Db) {
  const httpByStatus = new Map<string, number>();
  app.addHook('onResponse', async (req, reply) => {
    if (req.url === '/metrics') return;
    const key = `${Math.floor(reply.statusCode / 100)}xx`;
    httpByStatus.set(key, (httpByStatus.get(key) ?? 0) + 1);
  });

  app.get('/health', async (_req, reply) => {
    try {
      const { rows } = await db.query('SELECT now() AS db_time');
      return { ok: true, dbTime: rows[0].db_time };
    } catch {
      return reply.code(503).send({ ok: false, error: 'database unreachable' });
    }
  });

  app.get('/metrics', async (_req, reply) => {
    const [byStatus, outbox] = await Promise.all([
      db.query<{ status: string; n: number }>(
        `SELECT s.status::text AS status, count(b.id)::int AS n
         FROM unnest(enum_range(NULL::booking_status)) AS s(status)
         LEFT JOIN bookings b ON b.status = s.status GROUP BY s.status ORDER BY s.status`,
      ),
      db.query<{ pending: number; lag: number }>(
        `SELECT count(*)::int AS pending,
                coalesce(extract(epoch FROM now() - min(created_at)), 0)::float AS lag
         FROM notifications WHERE delivered_at IS NULL`,
      ),
    ]);
    const lines = [
      '# HELP slotbook_bookings Bookings by lifecycle status (expired = holds that timed out).',
      '# TYPE slotbook_bookings gauge',
      ...byStatus.rows.map((r) => `slotbook_bookings{status="${r.status}"} ${r.n}`),
      '# HELP slotbook_notifications_pending Outbox rows not yet delivered.',
      '# TYPE slotbook_notifications_pending gauge',
      `slotbook_notifications_pending ${outbox.rows[0].pending}`,
      '# HELP slotbook_notification_lag_seconds Age of the oldest undelivered notification.',
      '# TYPE slotbook_notification_lag_seconds gauge',
      `slotbook_notification_lag_seconds ${outbox.rows[0].lag.toFixed(3)}`,
      '# HELP slotbook_http_responses_total HTTP responses served by this instance, by status class.',
      '# TYPE slotbook_http_responses_total counter',
      ...[...httpByStatus.entries()].sort().map(([k, v]) => `slotbook_http_responses_total{class="${k}"} ${v}`),
      '',
    ];
    return reply.type('text/plain; version=0.0.4').send(lines.join('\n'));
  });
}
