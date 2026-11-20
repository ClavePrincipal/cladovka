// Deposits and withdrawals. Money only moves on a verified provider webhook (deposits)
// or after a finance officer approves the payout (withdrawals). Every step is idempotent.
import { tx } from '../lib/db.js';
import { post, balances } from '../lib/ledger.js';
import { assertDepositAllowed } from '../lib/rg.js';
import { grantWelcome } from '../lib/bonus.js';
import * as aml from '../lib/aml.js';
import { fail } from '../lib/errors.js';
import { metrics } from '../lib/metrics.js';

export function makePayments({ pool, cfg, providers, audit }) {
  async function applyEvent(c, ev) {
    const pay = (await c.query('SELECT * FROM payments WHERE id=$1 FOR UPDATE', [ev.paymentId])).rows[0];
    if (!pay) fail('NOT_FOUND', 'Payment not found', 404);
    if (pay.provider_ref && ev.providerRef && pay.provider_ref !== ev.providerRef) fail('MISMATCH', 'Provider reference mismatch', 400);
    if (ev.amount != null && ev.amount !== pay.amount) fail('MISMATCH', 'Amount mismatch', 400);

    if (pay.direction === 'deposit') {
      if (['succeeded', 'failed'].includes(pay.status)) return { status: pay.status, duplicate: true };
      if (ev.status === 'succeeded') {
        await post(c, { userId: pay.user_id, type: 'deposit', amount: pay.amount, refType: 'payment', refId: pay.id, key: `dep:${pay.id}`, meta: { provider: pay.provider, method: pay.method } });
        await c.query(`UPDATE payments SET status='succeeded', updated_at=now() WHERE id=$1`, [pay.id]);
        if (pay.with_bonus) await grantWelcome(c, cfg, pay.user_id, pay.amount, pay.id);
        await aml.onDeposit(c, cfg, pay.user_id, pay.amount);
        metrics.deposits.inc({ provider: pay.provider }, pay.amount);
        return { status: 'succeeded' };
      }
      await c.query(`UPDATE payments SET status='failed', updated_at=now() WHERE id=$1`, [pay.id]);
      return { status: 'failed' };
    }
    // withdrawal: provider reports payout result
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

  async function release(c, pay, status) {
    await post(c, { userId: pay.user_id, kind: 'withdraw_hold', type: 'withdrawal_release', amount: -pay.amount, refType: 'payment', refId: pay.id, key: `wd:rel:${pay.id}:out` });
    await post(c, { userId: pay.user_id, kind: 'cash', type: 'withdrawal_release', amount: pay.amount, refType: 'payment', refId: pay.id, key: `wd:rel:${pay.id}:in` });
    await c.query(`UPDATE payments SET status=$2, updated_at=now() WHERE id=$1`, [pay.id, status]);
  }

  return {
    methods: () => providers.methods(),

    createDeposit: (user, { provider, method, amount, withBonus, idempotencyKey }) => tx(pool, async c => {
      const { p, m } = providers.find(provider, method);
      if (!Number.isSafeInteger(amount) || amount < m.min || amount > m.max) fail('AMOUNT', `Сумма для ${m.name}: от ${m.min / 100} до ${m.max / 100}`, 400);
      if (user.status !== 'active') fail('ACCOUNT_BLOCKED', 'Аккаунт заблокирован', 403);
      if (idempotencyKey) {
        const ex = (await c.query('SELECT * FROM payments WHERE idempotency_key=$1 AND user_id=$2', [idempotencyKey, user.id])).rows[0];
        if (ex) return { paymentId: ex.id, redirectUrl: `/pay/${ex.provider}/${ex.id}`, duplicate: true };
      }
      await assertDepositAllowed(c, user.id, amount);
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

    requestWithdrawal: (user, { provider, method, amount }) => tx(pool, async c => {
      const { p, m } = providers.find(provider, method);
      if (!Number.isSafeInteger(amount) || amount < m.min || amount > m.max) fail('AMOUNT', `Сумма для ${m.name}: от ${m.min / 100} до ${m.max / 100}`, 400);
      const u = (await c.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [user.id])).rows[0];
      if (u.status === 'blocked') fail('ACCOUNT_BLOCKED', 'Аккаунт заблокирован. Обратитесь в поддержку.', 403);
      if (cfg.KYC_REQUIRED_FOR_WITHDRAWAL && u.kyc_status !== 'verified') fail('KYC_REQUIRED', 'Для вывода пройдите верификацию личности', 403);
      const t = (await c.query(`SELECT
          COALESCE(SUM(-amount) FILTER (WHERE type='bet' AND account_kind='cash'),0)::bigint AS turnover,
          COALESCE(SUM(amount) FILTER (WHERE type='deposit'),0)::bigint AS deposits
        FROM ledger WHERE user_id=$1`, [u.id])).rows[0];
      const ratio = t.deposits ? t.turnover / t.deposits : Infinity;
      if (ratio < cfg.DEPOSIT_TURNOVER_BEFORE_WITHDRAWAL)
        fail('TURNOVER', `Перед выводом сделайте ставки на сумму пополнений. Осталось: ${Math.ceil((t.deposits * cfg.DEPOSIT_TURNOVER_BEFORE_WITHDRAWAL - t.turnover) / 100)}`, 403);
      const pay = (await c.query(`INSERT INTO payments (user_id, direction, provider, method, amount, currency, status)
        VALUES ($1,'withdrawal',$2,$3,$4,$5,'review') RETURNING *`, [u.id, p.id, m.id, amount, u.currency])).rows[0];
      await post(c, { userId: u.id, type: 'withdrawal_hold', amount: -amount, refType: 'payment', refId: pay.id, key: `wd:hold:${pay.id}:out` });
      await post(c, { userId: u.id, kind: 'withdraw_hold', type: 'withdrawal_hold', amount, refType: 'payment', refId: pay.id, key: `wd:hold:${pay.id}:in` });
      await aml.onWithdrawal(c, cfg, u.id, amount, ratio);
      return { paymentId: pay.id, status: 'review', balance: (await balances(c, u.id)).cash };
    }),

    cancelWithdrawal: (userId, id) => tx(pool, async c => {
      const pay = (await c.query(`SELECT * FROM payments WHERE id=$1 AND user_id=$2 AND direction='withdrawal' FOR UPDATE`, [id, userId])).rows[0];
      if (!pay || pay.status !== 'review') fail('NOT_CANCELLABLE', 'Заявку уже нельзя отменить', 409);
      await release(c, pay, 'rejected');
      return { status: 'rejected', balance: (await balances(c, userId)).cash };
    }),

    /** Finance decision. Approve sends the payout to the provider; reject returns money to the player. */
    review: (staff, id, decision, note, ip) => tx(pool, async c => {
      const pay = (await c.query(`SELECT * FROM payments WHERE id=$1 AND direction='withdrawal' FOR UPDATE`, [id])).rows[0];
      if (!pay) fail('NOT_FOUND', 'Заявка не найдена', 404);
      if (pay.status !== 'review') fail('ALREADY_REVIEWED', 'Заявка уже обработана', 409);
      await c.query(`UPDATE payments SET reviewed_by=$2, review_note=$3 WHERE id=$1`, [id, staff.id, note ?? null]);
      if (decision === 'reject') await release(c, pay, 'rejected');
      else {
        const r = await providers.get(pay.provider).createPayout(pay);
        await c.query(`UPDATE payments SET status='approved', provider_ref=$2, updated_at=now() WHERE id=$1`, [id, r.providerRef]);
      }
      await audit(c, { actorType: 'staff', actorId: staff.id, action: `withdrawal_${decision}`, targetType: 'payment', targetId: id, ip, details: { amount: pay.amount, note } });
      return { status: decision === 'reject' ? 'rejected' : 'approved' };
    }),
  };
}
