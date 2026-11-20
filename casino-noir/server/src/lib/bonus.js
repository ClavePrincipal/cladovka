// Welcome bonus as a "release" bonus: credited to a separate bonus account and moved to cash once the player
// has wagered bonus × BONUS_WAGER of their own cash. Bets are always taken from cash.
//
// Anti-abuse rules (without them low-edge games make the bonus a guaranteed profit, e.g. Dice at 98% RTP:
// 30× wagering costs only 0.6× bonus):
//  - casino bonus: each game contributes a share of the stake (slots 100%, crash/mines 20%, roulette/dice 10%);
//  - sport bonus: only accumulators of ≥3 legs with every leg ≥1.40, counted when the bet is settled (voids never count);
//  - one bonus per person: a payment instrument that already received a bonus on another account gets none;
//  - requesting a withdrawal forfeits an active bonus (the player confirms this in the UI).
import { post } from './ledger.js';

export const CASINO_WEIGHTS = { slot: 1, crash: 0.2, mines: 0.2, roulette: 0.1, dice: 0.1 };
export const SPORT_RULES = { minLegs: 3, minLegOdds: 1.4 };

async function raiseAlert(c, userId, rule, severity, details) {
  const dup = await c.query(`SELECT 1 FROM aml_alerts WHERE user_id=$1 AND rule=$2 AND status='open' LIMIT 1`, [userId, rule]);
  if (!dup.rowCount) await c.query('INSERT INTO aml_alerts (user_id, rule, severity, details) VALUES ($1,$2,$3,$4)', [userId, rule, severity, details]);
}

export async function grantWelcome(c, cfg, userId, depositAmount, paymentId, instrument) {
  const u = (await c.query('SELECT bonus_pref FROM users WHERE id=$1', [userId])).rows[0];
  if (!u || u.bonus_pref === 'none') return 0;
  if ((await c.query('SELECT 1 FROM bonuses WHERE user_id = $1 LIMIT 1', [userId])).rowCount) return 0;
  if (instrument) {
    const other = await c.query('SELECT user_id FROM bonuses WHERE instrument = $1 AND user_id <> $2 LIMIT 1', [instrument, userId]);
    if (other.rowCount) {
      await raiseAlert(c, userId, 'bonus_instrument_reuse', 'medium', { instrument, otherUserId: other.rows[0].user_id, paymentId });
      return 0;
    }
  }
  const amount = Math.min(Math.floor(depositAmount * cfg.WELCOME_BONUS_PCT / 100), cfg.WELCOME_BONUS_MAX);
  if (amount <= 0) return 0;
  const b = await c.query(
    `INSERT INTO bonuses (user_id, amount, wager_req, expires_at, product, instrument)
     VALUES ($1,$2,$3, now() + make_interval(days => $4), $5, $6) RETURNING id`,
    [userId, amount, amount * cfg.BONUS_WAGER, cfg.BONUS_DAYS, u.bonus_pref, instrument ?? null]);
  await post(c, { userId, kind: 'bonus', type: 'bonus_grant', amount, refType: 'bonus', refId: b.rows[0].id,
    key: `bonus:welcome:${userId}`, meta: { paymentId } });
  return amount;
}

async function addWagering(c, userId, product, contribution) {
  if (contribution <= 0) return null;
  const r = await c.query(
    `UPDATE bonuses SET wagered = LEAST(wager_req, wagered + $3)
     WHERE user_id = $1 AND status = 'active' AND product = $2 AND expires_at > now() RETURNING id, amount, wagered, wager_req`,
    [userId, product, contribution]);
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

/** Casino stake → weighted contribution. */
export const progressCasino = (c, userId, game, stake) => addWagering(c, userId, 'casino', Math.floor(stake * (CASINO_WEIGHTS[game] ?? 0)));

/** Sport bet at settlement. legs: [{ odds, result }]. Voided bets and short/low-odds accumulators never count. */
export function progressSport(c, userId, bet, legs) {
  if (bet.kind !== 'express' || bet.status === 'void') return null;
  const live = legs.filter(l => l.result !== 'void');
  if (live.length < SPORT_RULES.minLegs || live.some(l => Number(l.odds) < SPORT_RULES.minLegOdds)) return null;
  return addWagering(c, userId, 'sport', bet.stake);
}

/** Withdrawal while a bonus is active: the bonus (not the player's own money) is cancelled. */
export async function forfeit(c, userId, reason) {
  const r = await c.query(`UPDATE bonuses SET status = 'forfeited' WHERE user_id = $1 AND status = 'active' RETURNING id`, [userId]);
  if (!r.rowCount) return 0;
  const bal = (await c.query(`SELECT balance FROM accounts WHERE user_id=$1 AND kind='bonus' FOR UPDATE`, [userId])).rows[0].balance;
  if (bal > 0) await post(c, { userId, kind: 'bonus', type: 'bonus_forfeit', amount: -bal, refType: 'bonus', refId: r.rows[0].id, key: `bonus:forfeit:${r.rows[0].id}`, meta: { reason } });
  return bal;
}

export async function expireDue(c) {
  const r = await c.query(`UPDATE bonuses SET status = 'expired' WHERE status = 'active' AND expires_at <= now() RETURNING id, user_id`);
  for (const b of r.rows) {
    const bal = (await c.query(`SELECT balance FROM accounts WHERE user_id=$1 AND kind='bonus' FOR UPDATE`, [b.user_id])).rows[0].balance;
    if (bal > 0) await post(c, { userId: b.user_id, kind: 'bonus', type: 'bonus_expire', amount: -bal, refType: 'bonus', refId: b.id, key: `bonus:expire:${b.id}` });
  }
  return r.rowCount;
}

/** Weekly cashback: CASHBACK_PCT of last week's net cash loss, no wagering. Skipped for weeks with an active bonus. */
export async function payCashback(c, cfg, now = new Date()) {
  if (!cfg.CASHBACK_PCT) return 0;
  // Previous ISO week in UTC: [Monday 00:00 of last week, Monday 00:00 of this week)
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const thisMonday = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 864e5);
  const lastMonday = new Date(thisMonday.getTime() - 7 * 864e5);
  const week = lastMonday.toISOString().slice(0, 10);
  const rows = (await c.query(`
    SELECT l.user_id, -SUM(l.amount)::bigint AS loss FROM ledger l JOIN users u ON u.id = l.user_id
    WHERE l.account_kind='cash' AND l.type IN ('bet','win','refund') AND l.created_at >= $1 AND l.created_at < $2 AND u.status='active'
      AND NOT EXISTS (SELECT 1 FROM bonuses b WHERE b.user_id=l.user_id AND b.created_at < $2 AND (b.status='active' OR b.created_at >= $1))
    GROUP BY l.user_id HAVING -SUM(l.amount) > 0`, [lastMonday, thisMonday])).rows;
  let n = 0;
  for (const r of rows) {
    const amount = Math.min(Math.floor(r.loss * cfg.CASHBACK_PCT / 100), cfg.CASHBACK_MAX);
    if (amount < cfg.CASHBACK_MIN) continue;
    const res = await post(c, { userId: r.user_id, type: 'cashback', amount, refType: 'cashback', key: `cashback:${r.user_id}:${week}`, meta: { week, loss: r.loss } });
    if (!res.duplicate) n++;
  }
  return n;
}
