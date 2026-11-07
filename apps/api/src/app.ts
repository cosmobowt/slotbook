import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { Db } from './db.js';
import { ApiError } from './lib/errors.js';
import { hostRoutes } from './routes/host.js';
import { publicRoutes } from './routes/public.js';

export function buildApp(db: Db, opts: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({
    logger: opts.logger ?? false,
    genReqId: () => crypto.randomUUID(),
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      return reply.code(status).send({ error: { code: 'BAD_REQUEST', message: (err as Error).message } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
  });

  app.get('/health', async () => {
    const { rows } = await db.query('SELECT now() AS db_time');
    return { ok: true, dbTime: rows[0].db_time };
  });

  publicRoutes(app, db);
  hostRoutes(app, db);

  // In production the API also serves the built React app (one container, one origin).
  const here = path.dirname(fileURLToPath(import.meta.url));
  const webDist = [path.resolve(here, '../public'), path.resolve(here, '../../public')].find((p) => existsSync(p));
  if (webDist) {
    app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No such route' } });
      return reply.sendFile('index.html'); // SPA routes like /demo/intro-call
    });
  }
  return app;
}
