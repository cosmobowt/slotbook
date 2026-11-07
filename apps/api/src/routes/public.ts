import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db.js';
import { getSlots } from '../engine/availability.js';
import { cancelByGuest, confirmHold, createHold, getBookingByToken, rescheduleBooking } from '../engine/bookings.js';
import { errors } from '../lib/errors.js';

const iso = z.string().refine((s) => !Number.isNaN(Date.parse(s)) && /T/.test(s), 'must be an ISO-8601 instant');

const holdBody = z.object({ host: z.string().min(1), slug: z.string().min(1), start: iso });
const confirmBody = z.object({ name: z.string().trim().min(1).max(120), email: z.string().trim().email().max(254) });
const rescheduleBody = z.object({ start: iso });
const cancelBody = z.object({ reason: z.string().trim().max(500).optional() }).optional();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw errors.badRequest(r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
}

export function publicRoutes(app: FastifyInstance, db: Db) {
  app.get<{ Params: { host: string; slug: string }; Querystring: { from?: string; to?: string; tz?: string } }>(
    '/api/hosts/:host/events/:slug/slots',
    async (req) => getSlots(db, req.params.host, req.params.slug, req.query),
  );

  app.post('/api/holds', async (req, reply) => {
    const body = parse(holdBody, req.body);
    const key = req.headers['idempotency-key'];
    if (key !== undefined && (typeof key !== 'string' || key.length < 8 || key.length > 200)) {
      throw errors.badRequest('Idempotency-Key must be 8–200 characters');
    }
    const result = await createHold(db, body, key as string | undefined);
    if (result.replayed) reply.header('Idempotent-Replayed', 'true');
    return reply.code(result.status).send(result.body);
  });

  app.post<{ Params: { id: string } }>('/api/holds/:id/confirm', async (req) => {
    if (!z.string().uuid().safeParse(req.params.id).success) throw errors.notFound('Hold');
    return confirmHold(db, req.params.id, parse(confirmBody, req.body));
  });

  app.get<{ Params: { token: string } }>('/api/bookings/:token', async (req) => getBookingByToken(db, req.params.token));

  app.post<{ Params: { token: string } }>('/api/bookings/:token/reschedule', async (req) =>
    rescheduleBooking(db, req.params.token, parse(rescheduleBody, req.body).start),
  );

  app.post<{ Params: { token: string } }>('/api/bookings/:token/cancel', async (req) =>
    cancelByGuest(db, req.params.token, parse(cancelBody, req.body)?.reason ?? null),
  );
}
