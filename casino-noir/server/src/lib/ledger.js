import { fail } from './errors.js';

/**
 * Post one balance change. Must run inside a transaction (client from tx()).
 * Locks the account row, enforces non-negative balance, writes an append-only ledger row.
 * With an idempotency key, a repeated call returns the original result without moving money twice.
 */
export async function post(c, { userId, kind = 'cash', type, amount, refType = null, refId = null, key = null, meta = {} }) {
  if (!Number.isSafeInteger(amount) || amount === 0) fail('BAD_AMOUNT', 'Некорректная сумма', 400);
  if (key) {
    const dup = await c.query('SELECT balance_after FROM ledger WHERE idempotency_key = $1', [key]);
    if (dup.rowCount) return { balance: dup.rows[0].balance_after, duplicate: true };
  }
  const acc = await c.query(
    `SELECT a.id, a.balance FROM accounts a WHERE a.user_id = $1 AND a.kind = $2 FOR UPDATE`, [userId, kind]);
  if (!acc.rowCount) fail('NO_ACCOUNT', 'Счёт не найден', 500);
  const next = acc.rows[0].balance + amount;
  if (next < 0) fail('INSUFFICIENT_FUNDS', 'Недостаточно средств на счёте', 409);
  await c.query('UPDATE accounts SET balance = $1 WHERE id = $2', [next, acc.rows[0].id]);
  await c.query(
    `INSERT INTO ledger (user_id, account_kind, type, amount, balance_after, ref_type, ref_id, idempotency_key, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [userId, kind, type, amount, next, refType, refId, key, meta]);
  return { balance: next, duplicate: false };
}

export async function balances(c, userId) {
  const r = await c.query('SELECT kind, balance FROM accounts WHERE user_id = $1', [userId]);
  const out = { cash: 0, bonus: 0, withdraw_hold: 0 };
  for (const row of r.rows) out[row.kind] = row.balance;
  return out;
}

export async function openAccounts(c, userId, currency) {
  await c.query(
    `INSERT INTO accounts (user_id, kind, currency) VALUES ($1,'cash',$2),($1,'bonus',$2),($1,'withdraw_hold',$2)`,
    [userId, currency]);
}

/** Compares every account balance with the sum of its ledger rows. Returns mismatches (should be empty). */
export async function reconcile(c) {
  const r = await c.query(`
    SELECT a.user_id, a.kind, a.balance, COALESCE(SUM(l.amount),0)::bigint AS ledger_sum
    FROM accounts a LEFT JOIN ledger l ON l.user_id = a.user_id AND l.account_kind = a.kind
    GROUP BY a.id HAVING a.balance <> COALESCE(SUM(l.amount),0)`);
  return r.rows;
}
