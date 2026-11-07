import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTx, type Db } from '../db.js';
import { cancelByHost } from '../engine/bookings.js';
import { isValidZone } from '../engine/slots.js';
import { login, requireHost } from '../lib/auth.js';
import { errors } from '../lib/errors.js';

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');
const slug = z.string().regex(/^[a-z0-9-]{2,60}$/, 'lowercase letters, digits, dashes');

const eventTypeBody = z.object({
  name: z.string().trim().min(1).max(120),
  slug,
  durationMin: z.number().int().min(15).max(120),
  capacity: z.number().int().min(1).max(500),
  bufferBeforeMin: z.number().int().min(0).max(30).default(0),
  bufferAfterMin: z.number().int().min(0).max(30).default(0),
  minNoticeMin: z.number().int().min(0).max(60 * 24 * 30).default(240),
  horizonDays: z.number().int().min(1).max(365).default(30),
  active: z.boolean().default(true),
});

const availabilityBody = z.object({
  rules: z.array(z.object({ weekday: z.number().int().min(1).max(7), start: time, end: time })).max(50),
  overrides: z
    .array(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        start: time.nullable(),
        end: time.nullable(),
      }),
    )
    .max(400),
});

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw errors.badRequest(r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
}

export function hostRoutes(app: FastifyInstance, db: Db) {
  app.post('/api/host/login', async (req) => {
    const body = parse(z.object({ username: z.string(), password: z.string() }), req.body);
    return { token: await login(db, body.username, body.password) };
  });

  app.get('/api/host/me', async (req) => {
    const hostId = await requireHost(db, req);
    const { rows } = await db.query('SELECT username, display_name AS "displayName", timezone FROM hosts WHERE id = $1', [hostId]);
    return rows[0];
  });

  app.patch('/api/host/me', async (req) => {
    const hostId = await requireHost(db, req);
    const { timezone } = parse(z.object({ timezone: z.string() }), req.body);
    if (!isValidZone(timezone)) throw errors.badRequest(`Unknown IANA time zone: ${timezone}`);
    await db.query('UPDATE hosts SET timezone = $2 WHERE id = $1', [hostId, timezone]);
    return { timezone };
  });

  app.get('/api/host/event-types', async (req) => {
    const hostId = await requireHost(db, req);
    const { rows } = await db.query(
      `SELECT id, name, slug, duration_min AS "durationMin", capacity, buffer_before_min AS "bufferBeforeMin",
              buffer_after_min AS "bufferAfterMin", min_notice_min AS "minNoticeMin", horizon_days AS "horizonDays", active
       FROM event_types WHERE host_id = $1 ORDER BY name`,
      [hostId],
    );
    return rows;
  });

  app.post('/api/host/event-types', async (req, reply) => {
    const hostId = await requireHost(db, req);
    const e = parse(eventTypeBody, req.body);
    try {
      const { rows } = await db.query(
        `INSERT INTO event_types (host_id, name, slug, duration_min, capacity, buffer_before_min, buffer_after_min,
                                  min_notice_min, horizon_days, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [hostId, e.name, e.slug, e.durationMin, e.capacity, e.bufferBeforeMin, e.bufferAfterMin, e.minNoticeMin, e.horizonDays, e.active],
      );
      return reply.code(201).send({ id: rows[0].id, ...e });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw errors.badRequest('Slug already in use');
      throw err;
    }
  });

  app.put<{ Params: { id: string } }>('/api/host/event-types/:id', async (req) => {
    const hostId = await requireHost(db, req);
    const e = parse(eventTypeBody, req.body);
    const { rowCount } = await db.query(
      `UPDATE event_types SET name=$3, slug=$4, duration_min=$5, capacity=$6, buffer_before_min=$7, buffer_after_min=$8,
              min_notice_min=$9, horizon_days=$10, active=$11
       WHERE id = $1 AND host_id = $2`,
      [req.params.id, hostId, e.name, e.slug, e.durationMin, e.capacity, e.bufferBeforeMin, e.bufferAfterMin, e.minNoticeMin, e.horizonDays, e.active],
    );
    if (!rowCount) throw errors.notFound('Event type');
    return { id: req.params.id, ...e };
  });

  app.get('/api/host/availability', async (req) => {
    const hostId = await requireHost(db, req);
    const [rules, overrides] = await Promise.all([
      db.query(`SELECT weekday, to_char(start_time,'HH24:MI') AS start, to_char(end_time,'HH24:MI') AS "end"
                FROM availability_rules WHERE host_id = $1 ORDER BY weekday, start_time`, [hostId]),
      db.query(`SELECT on_date AS date, to_char(start_time,'HH24:MI') AS start, to_char(end_time,'HH24:MI') AS "end"
                FROM date_overrides WHERE host_id = $1 ORDER BY on_date, start_time`, [hostId]),
    ]);
    return { rules: rules.rows, overrides: overrides.rows };
  });

  // Replace-all in one transaction, so a guest never sees half-written availability.
  app.put('/api/host/availability', async (req) => {
    const hostId = await requireHost(db, req);
    const body = parse(availabilityBody, req.body);
    for (const w of [...body.rules, ...body.overrides]) {
      if ((w.start === null) !== (w.end === null)) throw errors.badRequest('start and end must both be set or both be null');
      if (w.start && w.end && w.start >= w.end) throw errors.badRequest(`window ${w.start}–${w.end} ends before it starts`);
    }
    await withTx(db, async (tx) => {
      await tx.query('DELETE FROM availability_rules WHERE host_id = $1', [hostId]);
      await tx.query('DELETE FROM date_overrides WHERE host_id = $1', [hostId]);
      for (const r of body.rules) {
        await tx.query('INSERT INTO availability_rules (host_id, weekday, start_time, end_time) VALUES ($1,$2,$3,$4)', [
          hostId, r.weekday, r.start, r.end,
        ]);
      }
      for (const o of body.overrides) {
        await tx.query('INSERT INTO date_overrides (host_id, on_date, start_time, end_time) VALUES ($1,$2,$3,$4)', [
          hostId, o.date, o.start, o.end,
        ]);
      }
    });
    return body;
  });

  app.get('/api/host/bookings', async (req) => {
    const hostId = await requireHost(db, req);
    const { rows } = await db.query(
      `SELECT b.id, b.start_at AS start, b.end_at AS "end", b.status, b.guest_name AS "guestName",
              b.guest_email AS "guestEmail", e.name AS "eventName", e.slug AS "eventSlug"
       FROM bookings b JOIN event_types e ON e.id = b.event_type_id
       WHERE b.host_id = $1 AND b.status = 'confirmed' AND b.end_at > now()
       ORDER BY b.start_at LIMIT 200`,
      [hostId],
    );
    return rows;
  });

  app.post<{ Params: { id: string } }>('/api/host/bookings/:id/cancel', async (req) => {
    const hostId = await requireHost(db, req);
    if (!z.string().uuid().safeParse(req.params.id).success) throw errors.notFound('Booking');
    const { reason } = parse(z.object({ reason: z.string().trim().min(1).max(500) }), req.body);
    return cancelByHost(db, hostId, req.params.id, reason);
  });

  app.get('/api/host/notifications', async (req) => {
    const hostId = await requireHost(db, req);
    const { rows } = await db.query(
      `SELECT n.id, n.type, n.payload, n.created_at AS "createdAt" FROM notifications n
       JOIN bookings b ON b.id = n.booking_id WHERE b.host_id = $1 ORDER BY n.id DESC LIMIT 50`,
      [hostId],
    );
    return rows;
  });
}
