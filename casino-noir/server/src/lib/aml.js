// AML / fraud rules. Each rule writes an alert for the risk team; none of them moves money.
import { metrics } from './metrics.js';

async function alert(c, userId, rule, severity, details) {
  // One open alert per rule per user is enough; avoid flooding the queue.
  const dup = await c.query(`SELECT 1 FROM aml_alerts WHERE user_id=$1 AND rule=$2 AND status='open' LIMIT 1`, [userId, rule]);
  if (dup.rowCount) return;
  await c.query('INSERT INTO aml_alerts (user_id, rule, severity, details) VALUES ($1,$2,$3,$4)', [userId, rule, severity, details]);
  metrics.amlAlerts.inc({ rule });
}

export async function onRegister(c, user, ip) {
  if (!ip) return;
  const r = await c.query(`SELECT count(*)::int AS n FROM users WHERE reg_ip = $1 AND created_at > now() - interval '24 hours'`, [ip]);
  if (r.rows[0].n >= 3) await alert(c, user.id, 'multi_account_ip', 'medium', { ip, registrations24h: r.rows[0].n });
}

export async function onDeposit(c, cfg, userId, amount) {
  if (amount >= cfg.AML_LARGE_DEPOSIT) await alert(c, userId, 'large_deposit', 'medium', { amount });
  const r = await c.query(`SELECT count(*)::int AS n FROM payments WHERE user_id=$1 AND direction='deposit' AND status='succeeded'
    AND created_at > now() - interval '1 hour'`, [userId]);
  if (r.rows[0].n >= 5) await alert(c, userId, 'rapid_deposits', 'medium', { depositsLastHour: r.rows[0].n });
}

export async function onWithdrawal(c, cfg, userId, amount, turnoverRatio) {
  if (amount >= cfg.AML_LARGE_WITHDRAWAL) await alert(c, userId, 'large_withdrawal', 'high', { amount });
  if (turnoverRatio < 1.5) await alert(c, userId, 'low_turnover_withdrawal', 'low', { amount, turnoverRatio: +turnoverRatio.toFixed(2) });
}

export async function onBigWin(c, userId, game, bet, payout) {
  if (payout >= 1_000_000_00 || (bet > 0 && payout / bet >= 500))
    await alert(c, userId, 'big_win', 'low', { game, bet, payout, multiplier: +(payout / bet).toFixed(2) });
}
