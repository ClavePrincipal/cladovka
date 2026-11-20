import pg from 'pg';

// BIGINT -> JS number. Safe: balances stay far below 2^53 minor units (~90 trillion ₸).
pg.types.setTypeParser(20, v => Number(v));
pg.types.setTypeParser(1700, v => Number(v)); // NUMERIC
pg.types.setTypeParser(1016, v => pg.types.arrayParser.create(v, Number).parse()); // BIGINT[]

export function createPool(cfg) {
  return new pg.Pool({ connectionString: cfg.DATABASE_URL, max: cfg.DB_POOL_MAX, statement_timeout: 10_000 });
}

/** Run fn inside a transaction; retries on serialization failures / deadlocks. */
export async function tx(pool, fn, { retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      if ((e.code === '40001' || e.code === '40P01') && attempt < retries) continue;
      throw e;
    } finally {
      client.release();
    }
  }
}
