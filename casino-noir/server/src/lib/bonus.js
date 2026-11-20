// Welcome bonus as a "release" bonus: credited to a separate bonus account and moved to cash
// once the player has wagered bonus × BONUS_WAGER of their own cash. Bets are always taken from cash.
import { post } from './ledger.js';

export async function grantWelcome(c, cfg, userId, depositAmount, paymentId) {
  const prior = await c.query('SELECT 1 FROM bonuses WHERE user_id = $1 LIMIT 1', [userId]);
  if (prior.rowCount) return 0;
  const amount = Math.min(Math.floor(depositAmount * cfg.WELCOME_BONUS_PCT / 100), cfg.WELCOME_BONUS_MAX);
  if (amount <= 0) return 0;
  const b = await c.query(
    `INSERT INTO bonuses (user_id, amount, wager_req, expires_at) VALUES ($1,$2,$3, now() + make_interval(days => $4)) RETURNING id`,
    [userId, amount, amount * cfg.BONUS_WAGER, cfg.BONUS_DAYS]);
  await post(c, { userId, kind: 'bonus', type: 'bonus_grant', amount, refType: 'bonus', refId: b.rows[0].id,
    key: `bonus:welcome:${userId}`, meta: { paymentId } });
  return amount;
}

/** Called for every cash bet. Releases the bonus to cash when wagering is complete. */
export async function progress(c, userId, stake) {
  const r = await c.query(
    `UPDATE bonuses SET wagered = LEAST(wager_req, wagered + $2)
     WHERE user_id = $1 AND status = 'active' AND expires_at > now() RETURNING id, amount, wagered, wager_req`, [userId, stake]);
  if (!r.rowCount) return null;
  const b = r.rows[0];
  if (b.wagered < b.wager_req) return b;
  await c.query(`UPDATE bonuses SET status = 'released' WHERE id = $1`, [b.id]);
  const bal = (await c.query(`SELECT balance FROM accounts WHERE user_id=$1 AND kind='bonus' FOR UPDATE`, [userId])).rows[0].balance;
  const amt = Math.min(b.amount, bal);
  if (amt > 0) {
    await post(c, { userId, kind: 'bonus', type: 'bonus_release', amount: -amt, refType: 'bonus', refId: b.id, key: `bonus:release:${b.id}:out` });
    await post(c, { userId, kind: 'cash', type: 'bonus_release', amount: amt, refType: 'bonus', refId: b.id, key: `bonus:release:${b.id}:in` });
  }
  return { ...b, released: amt };
}

export async function expireDue(c) {
  const r = await c.query(`UPDATE bonuses SET status = 'expired' WHERE status = 'active' AND expires_at <= now() RETURNING id, user_id`);
  for (const b of r.rows) {
    const bal = (await c.query(`SELECT balance FROM accounts WHERE user_id=$1 AND kind='bonus' FOR UPDATE`, [b.user_id])).rows[0].balance;
    if (bal > 0) await post(c, { userId: b.user_id, kind: 'bonus', type: 'bonus_expire', amount: -bal, refType: 'bonus', refId: b.id, key: `bonus:expire:${b.id}` });
  }
  return r.rowCount;
}
