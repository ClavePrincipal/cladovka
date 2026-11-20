// Responsible gaming: account status, self-exclusion, loss limit, deposit limits with 24h cooling-off on increases.
import { fail } from './errors.js';

export async function getLimits(c, userId) {
  await c.query('INSERT INTO limits (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
  // Apply pending increases whose cooling-off has passed.
  await c.query(`
    UPDATE limits SET
      deposit_daily   = CASE WHEN pending ? 'deposit_daily'   THEN (pending->>'deposit_daily')::bigint   ELSE deposit_daily END,
      deposit_weekly  = CASE WHEN pending ? 'deposit_weekly'  THEN (pending->>'deposit_weekly')::bigint  ELSE deposit_weekly END,
      deposit_monthly = CASE WHEN pending ? 'deposit_monthly' THEN (pending->>'deposit_monthly')::bigint ELSE deposit_monthly END,
      loss_daily      = CASE WHEN pending ? 'loss_daily'      THEN (pending->>'loss_daily')::bigint      ELSE loss_daily END,
      pending = NULL, pending_effective_at = NULL, updated_at = now()
    WHERE user_id = $1 AND pending IS NOT NULL AND pending_effective_at <= now()`, [userId]);
  return (await c.query('SELECT * FROM limits WHERE user_id = $1', [userId])).rows[0];
}

const MONEY_LIMITS = ['deposit_daily', 'deposit_weekly', 'deposit_monthly', 'loss_daily'];

/** Decreases apply immediately; increases and removals wait 24 hours. */
export async function setLimits(c, userId, input) {
  const cur = await getLimits(c, userId);
  const now = {}, later = {};
  for (const k of MONEY_LIMITS) {
    if (!(k in input)) continue;
    const v = input[k] || null; // 0/null = no limit
    const old = cur[k];
    const stricter = v !== null && (old === null || v <= old);
    if (stricter) now[k] = v; else if (v !== old) later[k] = v;
  }
  if ('reality_check_min' in input) now.reality_check_min = input.reality_check_min || null;
  if (input.self_exclude_days) {
    const until = new Date(Date.now() + input.self_exclude_days * 864e5);
    if (!cur.self_excluded_until || until > cur.self_excluded_until) now.self_excluded_until = until;
  }
  const sets = Object.keys(now).map((k, i) => `${k} = $${i + 2}`);
  if (Object.keys(later).length) {
    sets.push(`pending = COALESCE(pending,'{}'::jsonb) || $${sets.length + 2}::jsonb`, `pending_effective_at = now() + interval '24 hours'`);
  }
  if (sets.length) {
    const vals = [...Object.values(now), ...(Object.keys(later).length ? [JSON.stringify(later)] : [])];
    await c.query(`UPDATE limits SET ${sets.join(', ')}, updated_at = now() WHERE user_id = $1`, [userId, ...vals]);
  }
  return { applied: Object.keys(now), pending: Object.keys(later) };
}

export async function assertCanPlay(c, user, stake) {
  if (user.status !== 'active') fail('ACCOUNT_BLOCKED', 'Аккаунт заблокирован. Обратитесь в поддержку.', 403);
  const l = await getLimits(c, user.id);
  if (l.self_excluded_until && l.self_excluded_until > new Date())
    fail('SELF_EXCLUDED', `Самоисключение активно до ${l.self_excluded_until.toLocaleString('ru-RU')}`, 403);
  if (l.loss_daily) {
    const r = await c.query(`SELECT COALESCE(-SUM(amount),0)::bigint AS loss FROM ledger
      WHERE user_id = $1 AND account_kind = 'cash' AND type IN ('bet','win','refund') AND created_at >= date_trunc('day', now())`, [user.id]);
    if (r.rows[0].loss + stake > l.loss_daily) fail('LOSS_LIMIT', 'Достигнут ваш дневной лимит проигрыша', 403);
  }
}

export async function assertDepositAllowed(c, cfg, userId, amount) {
  const l = await getLimits(c, userId);
  if (l.self_excluded_until && l.self_excluded_until > new Date()) fail('SELF_EXCLUDED', 'Пополнение недоступно во время самоисключения', 403);
  const checks = [['deposit_daily', '1 day', 'дневной'], ['deposit_weekly', '7 days', 'недельный'], ['deposit_monthly', '30 days', 'месячный']];
  for (const [k, interval, name] of checks) {
    if (!l[k]) continue;
    const r = await c.query(`SELECT COALESCE(SUM(amount),0)::bigint AS s FROM payments
      WHERE user_id = $1 AND direction = 'deposit' AND created_at >= now() - $2::interval
        AND (status = 'succeeded' OR (status IN ('created','pending') AND created_at > now() - make_interval(mins => $3)))`, [userId, interval, cfg.PENDING_DEPOSIT_TTL_MIN]);
    if (r.rows[0].s + amount > l[k]) fail('DEPOSIT_LIMIT', `Превышен ваш ${name} лимит депозита`, 403);
  }
}
