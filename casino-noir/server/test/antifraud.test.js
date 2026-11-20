// Abuse and fraud scenarios: every test is an attack (or a mistake) that must fail safely.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, client, register, deposit, sign, card, kyc, staffClient, cfg } from './helpers.js';
import { totpCode } from '../src/lib/crypto.js';
import { payCashback } from '../src/lib/bonus.js';
import { tx } from '../src/lib/db.js';
import { post } from '../src/lib/ledger.js';

let app, pool;
before(async () => ({ app, pool } = await setup()));
after(async () => { await app.close(); await pool.end(); });

const me = async c => (await c.get('/api/me')).body;
const verifyUser = (publicId, doc) => kyc(app, publicId, 'verified', doc);
const age = (publicId, hours) => pool.query(`UPDATE users SET created_at = now() - make_interval(hours => $2) WHERE public_id=$1`, [publicId, hours]);
/** Deterministic balance top-up (staff adjustment), so tests do not depend on game luck. */
const topUp = async (publicId, amount) => tx(pool, async c => {
  const id = (await c.query('SELECT id FROM users WHERE public_id=$1', [publicId])).rows[0].id;
  await post(c, { userId: id, type: 'adjustment', amount, meta: { reason: 'test' } });
});
const alerts = async (publicId, rule) => (await pool.query(`SELECT a.* FROM aml_alerts a JOIN users u ON u.id=a.user_id WHERE u.public_id=$1 AND a.rule=$2`, [publicId, rule])).rows;

test('bonus: low-edge games barely count towards wagering (dice 10%, slots 100%)', async () => {
  const c = client(app); await register(c); await deposit(c, 1_000_000, true);
  await c.post('/api/games/dice', { bet: 100_000, chance: 95 });
  assert.equal((await me(c)).bonus.wagered, 10_000, 'dice contributes 10% of the stake');
  await c.post('/api/games/slot', { bet: 10_000 });
  assert.equal((await me(c)).bonus.wagered, 20_000, 'slots contribute 100%');
});

test('bonus: sport bonus counts only settled accumulators of 3+ legs at 1.40+, never voids or singles', async () => {
  const c = client(app); await register(c, { bonusPref: 'sport' }); await deposit(c, 1_000_000, true);
  const { svc } = app.ctx;
  const mk = p => svc.sport.create({ sport: 'football', league: 'T', home: 'A', away: 'B', startsAt: new Date(Date.now() + 3600e3).toISOString(), probs: p, margin: 0.05 });
  const ev = [await mk([0.4, 0.3, 0.3]), await mk([0.4, 0.3, 0.3]), await mk([0.4, 0.3, 0.3]), await mk([0.9, 0.05, 0.05])];
  const sel = (e, o = 0) => ({ eventId: e.id, outcome: o, odds: e.odds[o] });
  assert.equal((await c.post('/api/sport/bets', { kind: 'single', stake: 50_000, selections: [sel(ev[0])] })).status, 200);
  assert.equal((await c.post('/api/sport/bets', { kind: 'express', stake: 50_000, selections: [sel(ev[1]), sel(ev[2]), sel(ev[3])] })).status, 200); // leg at 1.05
  assert.equal((await c.post('/api/sport/bets', { kind: 'express', stake: 50_000, selections: [sel(ev[0], 1), sel(ev[1], 1), sel(ev[2], 1)] })).status, 200);
  assert.equal((await me(c)).bonus.wagered, 0, 'nothing counts at placement');
  for (const e of ev) await svc.sport.settle(e.id, { result: 0 });
  assert.equal((await me(c)).bonus.wagered, 50_000, 'only the qualifying accumulator counts');
});

test('bonus: one bonus per card — a second account with the same card gets none and is flagged', async () => {
  const a = client(app); await register(a); await deposit(a, 1_000_000, true, '1111');
  const b = client(app); const rb = await register(b); await deposit(b, 1_000_000, true, '1111');
  assert.equal((await me(a)).bonusBalance, 1_000_000);
  assert.equal((await me(b)).bonusBalance, 0);
  assert.equal((await alerts(rb.body.user.id, 'bonus_instrument_reuse')).length, 1);
  assert.equal((await alerts(rb.body.user.id, 'shared_instrument'))[0].severity, 'high');
});

test('withdrawal: only to an instrument used for deposits; active bonus is forfeited only with consent', async () => {
  const c = client(app); const r = await register(c); await deposit(c, 1_000_000, true, '2222');
  await verifyUser(r.body.user.id, 'DOC-W1');
  await topUp(r.body.user.id, 1_000_000);
  for (let i = 0; i < 2; i++) assert.equal((await c.post('/api/games/dice', { bet: 500_000, chance: 50 })).status, 200);
  const w = { provider: 'sandbox', method: 'card', amount: 200_000 };
  assert.equal((await c.post('/api/wallet/withdraw', { ...w, instrument: 'card:••9999' })).body.error, 'INSTRUMENT');
  const inst = (await c.get('/api/wallet/instruments')).body;
  assert.deepEqual(inst.map(i => i.instrument), ['card:••2222']);
  const noConsent = await c.post('/api/wallet/withdraw', { ...w, instrument: 'card:••2222' });
  assert.equal(noConsent.body.error, 'BONUS_ACTIVE');
  const ok = await c.post('/api/wallet/withdraw', { ...w, instrument: 'card:••2222', forfeitBonus: true });
  assert.equal(ok.status, 200);
  const after = await me(c);
  assert.equal(after.bonusBalance, 0); assert.equal(after.bonus, null);
});

test('withdrawal: small + verified + clean + not new → paid automatically; large needs two different approvers', async () => {
  const c = client(app); const r = await register(c); await deposit(c, 2_000_000, false, '3333');
  await verifyUser(r.body.user.id, 'DOC-A1'); await age(r.body.user.id, 48);
  await topUp(r.body.user.id, 2_000_000); // enough for every bet below whatever the dice say
  for (let i = 0; i < 4; i++) assert.equal((await c.post('/api/games/dice', { bet: 500_000, chance: 50 })).status, 200);
  const small = await c.post('/api/wallet/withdraw', { provider: 'sandbox', method: 'card', instrument: 'card:••3333', amount: 200_000 });
  assert.equal(small.body.status, 'approved', JSON.stringify(small.body));
  const big = await c.post('/api/wallet/withdraw', { provider: 'sandbox', method: 'card', instrument: 'card:••3333', amount: 500_000 });
  assert.equal(big.body.status, 'review');
  const f1 = await staffClient(app, pool, 'f1@noir.test', 'finance'), f2 = await staffClient(app, pool, 'f2@noir.test', 'finance');
  const a1 = await f1.post(`/api/admin/withdrawals/${big.body.paymentId}/approve`, { note: 'ok' });
  assert.equal(a1.body.needsSecondApproval, true);
  assert.equal((await f1.post(`/api/admin/withdrawals/${big.body.paymentId}/approve`, {})).body.error, 'ALREADY_APPROVED');
  assert.equal((await f2.post(`/api/admin/withdrawals/${big.body.paymentId}/approve`, {})).body.status, 'approved');
});

test('chargeback: account blocked, sessions killed, remaining money recovered, risk alerted', async () => {
  const c = client(app); const r = await register(c); const pid = await deposit(c, 1_000_000);
  const p = (await pool.query('SELECT * FROM payments WHERE id=$1', [pid])).rows[0];
  const ev = sign({ paymentId: pid, providerRef: p.provider_ref, status: 'chargeback', amount: p.amount });
  assert.equal((await app.inject({ method: 'POST', url: '/api/webhooks/payments/sandbox', payload: ev.raw, headers: ev.headers })).statusCode, 200);
  assert.equal((await me(c)).user, null, 'session revoked');
  const u = (await pool.query(`SELECT u.status, a.balance FROM users u JOIN accounts a ON a.user_id=u.id AND a.kind='cash' WHERE u.public_id=$1`, [r.body.user.id])).rows[0];
  assert.equal(u.status, 'blocked'); assert.equal(u.balance, 0);
  assert.equal((await alerts(r.body.user.id, 'chargeback'))[0].severity, 'high');
});

test('abandoned checkouts do not eat the deposit limit once expired', async () => {
  const c = client(app); await register(c);
  await c.post('/api/me/limits', { depositDaily: 1_000_000 });
  const mk = () => c.post('/api/wallet/deposit', { provider: 'sandbox', method: 'card', amount: 600_000 });
  assert.equal((await mk()).status, 200);
  assert.equal((await mk()).body.error, 'DEPOSIT_LIMIT', 'a fresh pending checkout counts');
  await pool.query(`UPDATE payments SET created_at = now() - interval '2 hours' WHERE status='pending'`);
  await app.ctx.svc.payments.expirePending();
  assert.equal((await mk()).status, 200, 'expired checkout no longer blocks the limit');
});

test('account takeover: password change blocks withdrawals for 24h; 2FA is enforced at login', async () => {
  const c = client(app); const r = await register(c, { method: 'email', email: 'ato@example.com', password: 'first-password-1' });
  await deposit(c, 500_000, false, '4444'); await verifyUser(r.body.user.id, 'DOC-ATO');
  await c.post('/api/games/dice', { bet: 500_000, chance: 95 });
  await c.post('/api/me/password', { current: 'first-password-1', next: 'second-password-2' });
  const w = await c.post('/api/wallet/withdraw', { provider: 'sandbox', method: 'card', instrument: 'card:••4444', amount: 200_000 });
  assert.equal(w.body.error, 'SECURITY_HOLD');

  const setupR = await c.post('/api/me/2fa/setup', {});
  assert.equal((await c.post('/api/me/2fa/enable', { code: '000000' })).status, 400);
  assert.equal((await c.post('/api/me/2fa/enable', { code: totpCode(setupR.body.secret) })).body.user.totpEnabled, true);
  const x = client(app);
  assert.equal((await x.post('/api/auth/login', { login: 'ato@example.com', password: 'second-password-2' })).body.error, 'TOTP_REQUIRED');
  assert.equal((await x.post('/api/auth/login', { login: 'ato@example.com', password: 'second-password-2', totp: '123456' })).status, 401);
  assert.equal((await x.post('/api/auth/login', { login: 'ato@example.com', password: 'second-password-2', totp: totpCode(setupR.body.secret) })).status, 200);
  const sess = (await x.get('/api/me/sessions')).body;
  assert.ok(sess.length >= 2 && sess.some(s => s.current));
  assert.ok((await x.post('/api/me/sessions/revoke-others', {})).body.revoked >= 1);
  assert.equal((await me(c)).user, null, 'the other session is gone');
});

test('sportsbook: live bets wait and are re-checked; odds-change preferences; restricted players', async () => {
  const c = client(app); const r = await register(c); await deposit(c, 1_000_000);
  const { svc } = app.ctx;
  const e = await svc.sport.create({ sport: 'football', league: 'T', home: 'A', away: 'B', startsAt: new Date(Date.now() - 600e3).toISOString(), probs: [0.5, 0.25, 0.25], margin: 0.07 });
  await svc.sport.update(e.id, { status: 'live' });
  const seen = e.odds[0];
  // Trader suspends during the delay (goal!) → bet rejected.
  const pending = c.post('/api/sport/bets', { kind: 'single', stake: 10_000, selections: [{ eventId: e.id, outcome: 0, odds: seen }] });
  setTimeout(() => svc.sport.update(e.id, { status: 'suspended' }), 50);
  assert.equal((await pending).body.error, 'EVENT_CLOSED');
  await svc.sport.update(e.id, { status: 'live', probs: [0.4, 0.3, 0.3] }); // price moved up for outcome 0
  const higher = (await svc.sport.list()).find(x => x.id === e.id).odds[0];
  assert.ok(higher > seen);
  assert.equal((await c.post('/api/sport/bets', { kind: 'single', stake: 10_000, acceptChanges: 'none', selections: [{ eventId: e.id, outcome: 0, odds: seen }] })).body.error, 'ODDS_CHANGED');
  assert.equal((await c.post('/api/sport/bets', { kind: 'single', stake: 10_000, selections: [{ eventId: e.id, outcome: 0, odds: seen }] })).status, 200, 'higher accepted by default');
  await svc.sport.update(e.id, { probs: [0.6, 0.2, 0.2] });
  assert.equal((await c.post('/api/sport/bets', { kind: 'single', stake: 10_000, selections: [{ eventId: e.id, outcome: 0, odds: higher }] })).body.error, 'ODDS_CHANGED');
  assert.equal((await c.post('/api/sport/bets', { kind: 'single', stake: 10_000, acceptChanges: 'any', selections: [{ eventId: e.id, outcome: 0, odds: higher }] })).status, 200);

  const risk = await staffClient(app, pool, 'risk@noir.test', 'risk');
  const id = (await pool.query('SELECT id FROM users WHERE public_id=$1', [r.body.user.id])).rows[0].id;
  await risk.post(`/api/admin/players/${id}/stake-factor`, { factor: 0, reason: 'arbitrage' });
  assert.equal((await c.post('/api/sport/bets', { kind: 'single', stake: 10_000, acceptChanges: 'any', selections: [{ eventId: e.id, outcome: 0, odds: 1.01 }] })).body.error, 'SPORT_RESTRICTED');
});

test('identity: one person = one account; a self-excluded person cannot come back with a new account', async () => {
  const a = client(app); const ra = await register(a);
  assert.equal((await verifyUser(ra.body.user.id, 'ID-777')).json().status, 'verified');
  const b = client(app); const rb = await register(b);
  assert.equal((await verifyUser(rb.body.user.id, 'ID-777')).json().status, 'pending', 'duplicate goes to manual review');
  assert.equal((await alerts(rb.body.user.id, 'duplicate_identity')).length, 1);

  await a.post('/api/me/limits', { selfExcludeDays: 30 });
  const c = client(app); const rc = await register(c);
  assert.equal((await verifyUser(rc.body.user.id, 'ID-777')).json().status, 'rejected');
  assert.equal((await pool.query('SELECT status FROM users WHERE public_id=$1', [rc.body.user.id])).rows[0].status, 'blocked');
});

test('back office: support cannot verify KYC; idle staff sessions expire', async () => {
  const c = client(app); const r = await register(c);
  const id = (await pool.query('SELECT id FROM users WHERE public_id=$1', [r.body.user.id])).rows[0].id;
  const sup = await staffClient(app, pool, 'support@noir.test', 'support');
  assert.equal((await sup.post(`/api/admin/players/${id}/kyc`, { status: 'verified' })).status, 403);
  assert.equal((await sup.post(`/api/admin/players/${id}/kyc`, { status: 'rejected' })).status, 200);
  await pool.query(`UPDATE sessions SET last_seen = now() - interval '31 minutes' WHERE staff_id IS NOT NULL`);
  assert.equal((await sup.get('/api/admin/dashboard')).status, 401);
});

test('currency is fixed per deployment; weekly cashback is paid once on net loss', async () => {
  const c = client(app); const r = await register(c, { currency: 'USD' });
  assert.equal(r.body.user.currency, cfg.CURRENCY);
  await deposit(c, 1_000_000);
  await c.post('/api/games/dice', { bet: 500_000, chance: 1 }); // almost surely a loss
  const nextWeek = new Date(Date.now() + 7 * 864e5);
  const before = (await me(c)).balance;
  await tx(pool, cc => payCashback(cc, cfg, nextWeek));
  await tx(pool, cc => payCashback(cc, cfg, nextWeek)); // idempotent
  const got = (await me(c)).balance - before;
  const loss = 1_000_000 - before;
  assert.equal(got, loss > 0 ? Math.min(Math.floor(loss * cfg.CASHBACK_PCT / 100), cfg.CASHBACK_MAX) : 0);
});
