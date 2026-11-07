import { buildApp } from './app.js';
import { createPool } from './db.js';
import { expireHolds } from './engine/bookings.js';
import { migrate } from './migrate.js';
import { seed } from './seed.js';

const db = createPool();
await migrate(db);
if (process.env.SEED !== 'false') await seed(db);

const app = buildApp(db, { logger: true });

// Housekeeping: flip stale holds to 'expired'. Correctness never depends on this timer.
const sweeper = setInterval(() => {
  expireHolds(db)
    .then((n) => n && app.log.info({ expired: n }, 'expired stale holds'))
    .catch((err) => app.log.error({ err }, 'hold sweeper failed'));
}, 30_000);

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: '0.0.0.0' });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    clearInterval(sweeper);
    await app.close();
    await db.end();
    process.exit(0);
  });
}
