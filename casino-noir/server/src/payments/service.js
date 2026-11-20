// Deposits and withdrawals. Money only moves on a verified provider webhook (deposits)
// or after the payout is approved (withdrawals). Every step is idempotent.
//
// Anti-fraud rules:
//  - closed loop: a withdrawal can only go to an instrument (card, wallet, address) the player has deposited from,
//    so stolen-card money cannot be cashed out to the fraudster's own account and laundering through the casino fails;
//  - one instrument used by several accounts raises a high-risk alert (multi-accounting, stolen cards);
//  - a chargeback blocks the account, takes back what is left and alerts the risk team;
//  - withdrawals: KYC, deposit turnover, no security hold (password/2FA change), active bonus is forfeited;
//  - small withdrawals from clean verified accounts are paid automatically, large ones need two finance approvals.
import { tx } from '../lib/db.js';
import { post, balances } from '../lib/ledger.js';
import { assertDepositAllowed } from '../lib/rg.js';
import { grantWelcome, forfeit } from '../lib/bonus.js';
import * as aml from '../lib/aml.js';
import { fail } from '../lib/errors.js';
import { metrics } from '../lib/metrics.js';

export function makePayments({ pool, cfg, providers, audit }) {
  async function applyEvent(c, ev) {
    const pay = (await c.query('SELECT * FROM payments WHERE id=$1 FOR UPDATE', [ev.paymentId])).rows[0];
    if (!pay) fail('NOT_FOUND', 'Payment not found', 404);
    if (pay.provider_ref && ev.providerRef && pay.provider_ref !== ev.providerRef) fail('MISMATCH', 'Provider reference mismatch', 400);
    if (ev.amount != null && ev.amount !== pay.amount) fail('MISMATCH', 'Amount mismatch', 400);
    if (ev.currency != null && ev.currency !== pay.currency) fail('MISMATCH', 'Currency mismatch', 400);

    if (pay.direction === 'deposit') {
      if (ev.status === 'chargeback') return chargeback(c, pay);
      if (['succeeded', 'failed', 'chargeback'].includes(pay.status)) return { status: pay.status, duplicate: true };
      // 'expired' deposits are still credited: the money really arrived, only later than expected.
      if (ev.status === 'succeeded') {
        const instrument = ev.instrument ? String(ev.instrument).slice(0, 100) : null;
        await post(c, { userId: pay.user_id, type: 'deposit', amount: pay.amount, refType: 'payment', refId: pay.id, key: `dep:${pay.id}`, meta: { provider: pay.provider, method: pay.method } });
        await c.query(`UPDATE payments SET status='succeeded', instrument=$2, updated_at=now() WHERE id=$1`, [pay.id, instrument]);
        if (pay.with_bonus) await grantWelcome(c, cfg, pay.user_id, pay.amount, pay.id, instrument);
        await aml.onDeposit(c, cfg, pay.user_id, pay.amount);
        if (instrument) await aml.onInstrument(c, pay.user_id, instrument);
        metrics.deposits.inc({ provider: pay.provider }, pay.amount);
        return { status: 'succeeded' };
      }
      await c.query(`UPDATE payments SET status='failed', updated_at=now() WHERE id=$1`, [pay.id]);
      return { status: 'failed' };
    }
    // withdrawal: provider reports the payout result
    if (pay.status !== 'approved') return { status: pay.status, duplicate: true };
    if (ev.status === 'paid') {
      await post(c, { userId: pay.user_id, kind: 'withdraw_hold', type: 'withdrawal_paid', amount: -pay.amount, refType: 'payment', refId: pay.id, key: `wd:paid:${pay.id}` });
      await c.query(`UPDATE payments SET status='paid', updated_at=now() WHERE id=$1`, [pay.id]);
      metrics.withdrawals.inc({ provider: pay.provider }, pay.amount);
      return { status: 'paid' };
    }
    await release(c, pay, 'failed');
    return { status: 'failed' };
  }

  async function chargeback(c, pay) {
    if (pay.status === 'chargeback') return { status: 'chargeback', duplicate: true };
    const wasCredited = pay.status === 'succeeded';
    await c.query(`UPDATE payments SET status='chargeback', updated_at=now() WHERE id=$1`, [pay.id]);
    let recovered = 0;
    if (wasCredited) {
      await forfeit(c, pay.user_id, 'chargeback');
      const cash = (await balances(c, pay.user_id)).cash;
      recovered = Math.min(cash, pay.amount);
      if (recovered > 0) await post(c, { userId: pay.user_id, type: 'chargeback', amount: -recovered, refType: 'payment', refId: pay.id, key: `cb:${pay.id}` });
    }
    await c.query(`UPDATE users SET status='blocked' WHERE id=$1`, [pay.user_id]);
    await c.query(`UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [pay.user_id]);
    await aml.raise(c, pay.user_id, 'chargeback', 'high', { paymentId: pay.id, amount: pay.amount, recovered, shortfall: wasCredited ? pay.amount - recovered : 0 });
    await audit(c, { actorType: 'system', action: 'chargeback', targetType: 'user', targetId: pay.user_id, details: { paymentId: pay.id, recovered } });
    return { status: 'chargeback', recovered };
  }

  async function release(c, pay, status) {
    await post(c, { userId: pay.user_id, kind: 'withdraw_hold', type: 'withdrawal_release', amount: -pay.amount, refType: 'payment', refId: pay.id, key: `wd:rel:${pay.id}:out` });
    await post(c, { userId: pay.user_id, kind: 'cash', type: 'withdrawal_release', amount: pay.amount, refType: 'payment', refId: pay.id, key: `wd:rel:${pay.id}:in` });
    await c.query(`UPDATE payments SET status=$2, updated_at=now() WHERE id=$1`, [pay.id, status]);
  }

  async function sendPayout(c, pay) {
    const r = await providers.get(pay.provider).createPayout(pay);
    await c.query(`UPDATE payments SET status='approved', provider_ref=$2, updated_at=now() WHERE id=$1`, [pay.id, r.providerRef]);
  }

  /** Instruments the player has successfully deposited from: the only allowed payout destinations. */
  const instruments = (c, userId) => c.query(`SELECT provider, method, instrument, MAX(created_at) AS last_used FROM payments
      WHERE user_id=$1 AND direction='deposit' AND status='succeeded' AND instrument IS NOT NULL
      GROUP BY provider, method, instrument ORDER BY last_used DESC`, [userId]).then(r => r.rows);

  return {
    methods: () => providers.methods(),
    instruments: userId => instruments(pool, userId),

    createDeposit: (user, { provider, method, amount, withBonus, idempotencyKey }) => tx(pool, async c => {
      const { p, m } = providers.find(provider, method);
      if (!Number.isSafeInteger(amount) || amount < m.min || amount > m.max) fail('AMOUNT', `Сумма для ${m.name}: от ${m.min / 100} до ${m.max / 100}`, 400);
      if (user.status !== 'active') fail('ACCOUNT_BLOCKED', 'Аккаунт заблокирован', 403);
      if (idempotencyKey) {
        const ex = (await c.query('SELECT * FROM payments WHERE idempotency_key=$1 AND user_id=$2', [idempotencyKey, user.id])).rows[0];
        if (ex) return { paymentId: ex.id, redirectUrl: `/pay/${ex.provider}/${ex.id}`, duplicate: true };
      }
      await assertDepositAllowed(c, cfg, user.id, amount);
      const pay = (await c.query(`INSERT INTO payments (user_id, direction, provider, method, amount, currency, status, idempotency_key, with_bonus)
        VALUES ($1,'deposit',$2,$3,$4,$5,'created',$6,$7) RETURNING *`, [user.id, p.id, m.id, amount, user.currency, idempotencyKey ?? null, !!withBonus])).rows[0];
      const r = await p.createDeposit(pay);
      await c.query(`UPDATE payments SET provider_ref=$2, status='pending' WHERE id=$1`, [pay.id, r.providerRef]);
      return { paymentId: pay.id, redirectUrl: r.redirectUrl };
    }),

    /** Provider webhook entry point. Signature is verified by the provider adapter before anything else. */
    webhook: async (providerId, req) => {
      const ev = providers.get(providerId).verifyWebhook(req);
      return tx(pool, c => applyEvent(c, ev));
    },

    expirePending: () => pool.query(`UPDATE payments SET status='expired', updated_at=now()
      WHERE direction='deposit' AND status IN ('created','pending') AND created_at < now() - make_interval(mins => $1)`, [cfg.PENDING_DEPOSIT_TTL_MIN]).then(r => r.rowCount),

    requestWithdrawal: (user, { provider, method, instrument, amount, forfeitBonus }) => tx(pool, async c => {
      const { p, m } = providers.find(provider, method);
      if (!Number.isSafeInteger(amount) || amount < m.min || amount > m.max) fail('AMOUNT', `Сумма для ${m.name}: от ${m.min / 100} до ${m.max / 100}`, 400);
      const u = (await c.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [user.id])).rows[0];
      if (u.status === 'blocked') fail('ACCOUNT_BLOCKED', 'Аккаунт заблокирован. Обратитесь в поддержку.', 403);
      if (u.security_hold_until && u.security_hold_until > new Date())
        fail('SECURITY_HOLD', `Вывод доступен с ${u.security_hold_until.toLocaleString('ru-RU')}: после смены пароля или 2FA действует защитная пауза 24 часа`, 403);
      if (cfg.KYC_REQUIRED_FOR_WITHDRAWAL && u.kyc_status !== 'verified') fail('KYC_REQUIRED', 'Для вывода пройдите верификацию личности', 403);
      const allowed = await instruments(c, u.id);
      if (!allowed.some(i => i.provider === p.id && i.method === m.id && i.instrument === instrument))
        fail('INSTRUMENT', 'Вывод возможен только на карту или кошелёк, с которого вы пополняли счёт', 403);
      const t = (await c.query(`SELECT
          COALESCE(SUM(-amount) FILTER (WHERE type='bet' AND account_kind='cash'),0)::bigint AS turnover,
          COALESCE(SUM(amount) FILTER (WHERE type='deposit'),0)::bigint AS deposits
        FROM ledger WHERE user_id=$1`, [u.id])).rows[0];
      const ratio = t.deposits ? t.turnover / t.deposits : Infinity;
      if (ratio < cfg.DEPOSIT_TURNOVER_BEFORE_WITHDRAWAL)
        fail('TURNOVER', `Перед выводом сделайте ставки на сумму пополнений. Осталось: ${Math.ceil((t.deposits * cfg.DEPOSIT_TURNOVER_BEFORE_WITHDRAWAL - t.turnover) / 100)}`, 403);
      const bonus = (await c.query(`SELECT amount, wagered, wager_req FROM bonuses WHERE user_id=$1 AND status='active'`, [u.id])).rows[0];
      if (bonus && !forfeitBonus) fail('BONUS_ACTIVE', 'У вас есть неотыгранный бонус. При выводе он будет аннулирован.', 409, { bonus });
      if (bonus) await forfeit(c, u.id, 'withdrawal');

      const pay = (await c.query(`INSERT INTO payments (user_id, direction, provider, method, amount, currency, status, instrument)
        VALUES ($1,'withdrawal',$2,$3,$4,$5,'review',$6) RETURNING *`, [u.id, p.id, m.id, amount, u.currency, instrument])).rows[0];
      await post(c, { userId: u.id, type: 'withdrawal_hold', amount: -amount, refType: 'payment', refId: pay.id, key: `wd:hold:${pay.id}:out` });
      await post(c, { userId: u.id, kind: 'withdraw_hold', type: 'withdrawal_hold', amount, refType: 'payment', refId: pay.id, key: `wd:hold:${pay.id}:in` });
      await aml.onWithdrawal(c, cfg, u.id, amount, ratio);

      // Automatic payout for small amounts from clean, verified, not-new accounts.
      const risk = (await c.query(`SELECT
          (SELECT COUNT(*) FROM aml_alerts WHERE user_id=$1 AND status='open' AND severity IN ('medium','high'))::int AS alerts,
          (SELECT COUNT(*) FROM payments WHERE user_id=$1 AND status='chargeback')::int AS chargebacks`, [u.id])).rows[0];
      const oldEnough = Date.now() - u.created_at.getTime() >= cfg.NEW_ACCOUNT_HOLD_HOURS * 3600e3;
      let status = 'review';
      if (amount <= cfg.AUTO_APPROVE_WITHDRAWAL && u.kyc_status === 'verified' && !risk.alerts && !risk.chargebacks && oldEnough) {
        await sendPayout(c, pay); status = 'approved';
        await audit(c, { actorType: 'system', action: 'withdrawal_auto_approve', targetType: 'payment', targetId: pay.id, details: { amount } });
      }
      return { paymentId: pay.id, status, balance: (await balances(c, u.id)).cash };
    }),

    cancelWithdrawal: (userId, id) => tx(pool, async c => {
      const pay = (await c.query(`SELECT * FROM payments WHERE id=$1 AND user_id=$2 AND direction='withdrawal' FOR UPDATE`, [id, userId])).rows[0];
      if (!pay || pay.status !== 'review') fail('NOT_CANCELLABLE', 'Заявку уже нельзя отменить', 409);
      await release(c, pay, 'rejected');
      return { status: 'rejected', balance: (await balances(c, userId)).cash };
    }),

    /** Finance decision. Large amounts need approvals from two different staff members. */
    review: (staff, id, decision, note, ip) => tx(pool, async c => {
      const pay = (await c.query(`SELECT * FROM payments WHERE id=$1 AND direction='withdrawal' FOR UPDATE`, [id])).rows[0];
      if (!pay) fail('NOT_FOUND', 'Заявка не найдена', 404);
      if (pay.status !== 'review') fail('ALREADY_REVIEWED', 'Заявка уже обработана', 409);
      let result;
      if (decision === 'reject') { await release(c, pay, 'rejected'); result = { status: 'rejected' }; }
      else {
        if (pay.approvals.includes(staff.id)) fail('ALREADY_APPROVED', 'Вы уже одобрили эту заявку. Нужно одобрение другого сотрудника.', 409);
        const approvals = [...pay.approvals, staff.id];
        await c.query('UPDATE payments SET approvals=$2 WHERE id=$1', [id, approvals]);
        if (pay.amount >= cfg.FOUR_EYES_WITHDRAWAL && approvals.length < 2) result = { status: 'review', needsSecondApproval: true };
        else { await sendPayout(c, pay); result = { status: 'approved' }; }
      }
      await c.query(`UPDATE payments SET reviewed_by=$2, review_note=$3 WHERE id=$1`, [id, staff.id, note ?? null]);
      await audit(c, { actorType: 'staff', actorId: staff.id, action: `withdrawal_${decision}`, targetType: 'payment', targetId: id, ip, details: { amount: pay.amount, note, ...result } });
      return result;
    }),
  };
}
