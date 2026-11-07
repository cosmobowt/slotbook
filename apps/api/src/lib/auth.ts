import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { Db } from '../db.js';
import { errors } from './errors.js';

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(password, salt, 32).toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const actual = scryptSync(password, Buffer.from(salt, 'hex'), 32);
  return timingSafeEqual(actual, Buffer.from(hash, 'hex'));
}

export async function login(db: Db, username: string, password: string): Promise<string> {
  const { rows } = await db.query<{ id: string; password_hash: string }>(
    'SELECT id, password_hash FROM hosts WHERE username = $1',
    [username],
  );
  if (!rows[0] || !verifyPassword(password, rows[0].password_hash)) throw errors.unauthorized();
  const token = randomBytes(32).toString('base64url');
  await db.query(`INSERT INTO host_sessions (token, host_id, expires_at) VALUES ($1, $2, now() + interval '7 days')`, [
    token,
    rows[0].id,
  ]);
  return token;
}

/** Bearer token -> host id. Session expiry is judged by the DB clock like everything else. */
export async function requireHost(db: Db, req: FastifyRequest): Promise<string> {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) throw errors.unauthorized();
  const { rows } = await db.query<{ host_id: string }>(
    'SELECT host_id FROM host_sessions WHERE token = $1 AND expires_at > now()',
    [token],
  );
  if (!rows[0]) throw errors.unauthorized();
  return rows[0].host_id;
}
