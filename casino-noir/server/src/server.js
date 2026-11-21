import { loadConfig } from './config.js';
import { createPool, tx } from './lib/db.js';
import { buildApp } from './app.js';
import { migrate } from './scripts/migrate.js';
import { expireDue, payCashback } from './lib/bonus.js';
import { demoFeedTick } from './lib/demo-feed.js';

const cfg = loadConfig();
const pool = createPool(cfg);
await migrate(pool);
const app = await buildApp({ cfg, pool });

/** Background jobs. pg advisory locks make sure only one instance runs each job when scaled horizontally. */
function job(name, lockId, everyMs, fn) {
  const run = async () => {
    const c = await pool.connect();
    try {
      const { rows } = await c.query('SELECT pg_try_advisory_lock($1) AS ok', [lockId]);
      if (!rows[0].ok) return;
      try { await fn(); } finally { await c.query('SELECT pg_advisory_unlock($1)', [lockId]); }
    } catch (e) { app.log.error(e, `job ${name} failed`); } finally { c.release(); }
  };
  setInterval(run, everyMs).unref();
}
job('crash-sweeper', 7001, 3000, () => app.ctx.svc.casino.sweepCrash());
job('bonus-expiry', 7002, 5 * 60_000, () => tx(pool, expireDue));
job('session-cleanup', 7003, 60 * 60_000, async () => {
  await pool.query(`DELETE FROM sessions WHERE expires_at < now() - interval '30 days'`);
  await pool.query(`DELETE FROM login_failures WHERE at < now() - interval '1 day'`);
});
job('expire-pending-deposits', 7004, 5 * 60_000, () => app.ctx.svc.payments.expirePending());
job('weekly-cashback', 7005, 60 * 60_000, () => tx(pool, c => payCashback(c, cfg))); // idempotent per user+week
// Test stands only: a simulated odds feed keeps the demo line alive and settles bets.
if (cfg.NODE_ENV !== 'production' && process.env.DEMO_FEED !== 'false')
  job('demo-feed', 7006, 60_000, () => demoFeedTick({ pool, sport: app.ctx.svc.sport }));

const shutdown = async sig => { app.log.info(`${sig}: shutting down`); await app.close(); await pool.end(); process.exit(0); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);

await app.listen({ host: cfg.HOST, port: cfg.PORT });
