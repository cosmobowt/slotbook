import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, type Db } from './db.js';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
// From src/ (tsx) the first candidate matches; from dist/src/ (compiled) the second one does.
const candidates = [MIGRATIONS_DIR, path.resolve(MIGRATIONS_DIR, '..', '..', 'migrations')];

async function migrationsDir(): Promise<string> {
  for (const dir of candidates) {
    try {
      await readdir(dir);
      return dir;
    } catch {}
  }
  throw new Error('migrations directory not found');
}

/**
 * Applies pending .sql files in order. An advisory lock makes it safe for several
 * app instances to boot at once: only one runs migrations, the rest wait.
 */
export async function migrate(db: Db, log = console.log): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', ['slotbook:migrate']);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const dir = await migrationsDir();
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const done = new Set(rows.map((r) => r.name));
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log(`migrated ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['slotbook:migrate']).catch(() => {});
    client.release();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const db = createPool();
  migrate(db)
    .then(() => db.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
