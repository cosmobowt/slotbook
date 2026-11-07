import pg from 'pg';

// timestamptz -> JS Date is fine; keep `date` (OID 1082) as plain 'YYYY-MM-DD' strings, and
// `time` (1083) is already a string. No implicit local-time conversion anywhere.
pg.types.setTypeParser(1082, (v) => v);

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(connectionString = process.env.DATABASE_URL, max = 20): Db {
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  return new pg.Pool({ connectionString, max });
}

/** Run fn inside a READ COMMITTED transaction. Constraints + row locks give us correctness. */
export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Postgres SQLSTATE codes we translate into API errors. Match on code, never on message text. */
export const PG = {
  UNIQUE_VIOLATION: '23505',
  EXCLUSION_VIOLATION: '23P01',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
} as const;

/**
 * Two transactions that each lock a session row and then insert overlapping ranges can
 * wait on each other; Postgres detects the deadlock and aborts one. That is safe (nothing
 * was written) and retrying the whole transaction gives the loser a clean answer.
 */
export async function withTxRetry<T>(db: Db, fn: (tx: Tx) => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await withTx(db, fn);
    } catch (err) {
      const code = pgCode(err);
      const retryable = code === PG.DEADLOCK_DETECTED || code === PG.SERIALIZATION_FAILURE;
      if (!retryable || i >= attempts) throw err;
    }
  }
}

export function pgCode(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code;
}
