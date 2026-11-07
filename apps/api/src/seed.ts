import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, withTx, type Db } from './db.js';
import { hashPassword } from './lib/auth.js';

/**
 * Idempotent demo seed: host "demo" (password "demo1234"), home zone Asia/Kolkata,
 * Mon–Fri 09:00–13:00 and 14:00–17:00, two event types (one-on-one and a group session).
 */
export async function seed(db: Db, log = console.log) {
  await withTx(db, async (tx) => {
    const existing = await tx.query('SELECT id FROM hosts WHERE username = $1', ['demo']);
    if (existing.rows[0]) return;
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO hosts (username, display_name, timezone, password_hash) VALUES ('demo', 'Demo Host', 'Asia/Kolkata', $1)
       RETURNING id`,
      [hashPassword('demo1234')],
    );
    const hostId = rows[0].id;
    await tx.query(
      `INSERT INTO event_types (host_id, slug, name, duration_min, capacity, buffer_before_min, buffer_after_min, min_notice_min, horizon_days)
       VALUES ($1, 'intro-call', 'Intro call', 30, 1, 0, 10, 240, 30),
              ($1, 'group-workshop', 'Group workshop', 60, 5, 0, 15, 240, 30)`,
      [hostId],
    );
    for (let d = 1; d <= 5; d++) {
      await tx.query(
        `INSERT INTO availability_rules (host_id, weekday, start_time, end_time)
         VALUES ($1, $2, '09:00', '13:00'), ($1, $2, '14:00', '17:00')`,
        [hostId, d],
      );
    }
    log('seeded demo host: username "demo", password "demo1234"');
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const db = createPool();
  seed(db)
    .then(() => db.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
