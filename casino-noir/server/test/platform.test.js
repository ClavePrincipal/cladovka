import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { setup, client, register, deposit, sign, cfg } from './helpers.js';
import { totpCode, makePii } from '../src/lib/crypto.js';
import { hash } from '@node-rs/argon2';
import { floatsFor } from '../src/lib/fair.js';
import * as M from '../src/games/math.js';

let app, pool;
before(async () => ({ app, pool } = await setup()));
after(async () => { await app.close(); await pool.end(); });

const balanceOf = async c => (await c.get('/api/me')).body.balance;

test('registration: one-click returns credentials, rejects minors, login works, lockout after 5 failures', async () => {
  const c = client(app);
  const r = await register(c);
  assert.equal(r.status, 200);
  assert.match(r.body.credentials.id, /^\d{9}$/);
  assert.equal(r.body.balance, 0);

  const minor = await register(client(app), { birthDate: new Date(Date.now() - 17 * 365 * 864e5).toISOString().slice(0, 10) });
  assert.equal(minor.status, 403);

  const c2 = client(app);
  const ok = await c2.post('/api/auth/login', { login: r.body.credentials.id, password: r.body.credentials.password });
  assert.equal(ok.status, 200);

  const attacker = client(app);
  for (let i = 0; i < 5; i++) assert.equal((await attacker.post('/api/auth/login', { login: r.body.credentials.id, password: 'wrong' })).status, 401);
  assert.equal((await attacker.post('/api/auth/login', { login: r.body.credentials.id, password: r.body.credentials.password })).status, 429);
  // The owner, from another network, is not locked out by the attacker (no lockout-DoS).
  assert.equal((await client(app).post('/api/auth/login', { login: r.body.credentials.id, password: r.body.credentials.password })).status, 200);
});

test('email registration stores PII encrypted and searchable only by HMAC', async () => {
  const c = client(app);
  const r = await register(c, { method: 'email', email: 'Player@Example.com', password: 'very-strong-pass' });
  assert.equal(r.status, 200);
  const row = (await pool.query(`SELECT email_enc, email_hash FROM users WHERE public_id=$1`, [r.body.user.id])).rows[0];
  assert.ok(!row.email_enc.toString('utf8').includes('Example'), 'email must not be stored in plain text');
  assert.equal(makePii(cfg.PII_KEY, cfg.LOOKUP_KEY).dec(row.email_enc), 'Player@Example.com');
  const dup = await register(client(app), { method: 'email', email: 'player@example.com', password: 'very-strong-pass' });
  assert.equal(dup.status, 409);
});

test('CSRF: mutating requests without the token are rejected', async () => {
  const c = client(app); await register(c);
  c.setCsrf('forged');
  const r = await c.post('/api/games/slot', { bet: 10000 });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'CSRF');
  const noHeader = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { method: 'oneclick', birthDate: '1990-01-01', acceptTerms: true } });
  assert.equal(noHeader.statusCode, 403);
});

test('deposits: money moves only on a signed webhook, replays are idempotent, bonus granted once', async () => {
  const c = client(app); await register(c);
  const pid = await deposit(c, 1_000_000, true);           // 10 000 ₸
  const me = (await c.get('/api/me')).body;
  assert.equal(me.balance, 1_000_000);
  assert.equal(me.bonusBalance, 1_000_000);
  assert.equal(me.bonus.wager_req, 1_000_000 * cfg.BONUS_WAGER);

  const p = (await pool.query('SELECT * FROM payments WHERE id=$1', [pid])).rows[0];
  const ev = sign({ paymentId: pid, providerRef: p.provider_ref, status: 'succeeded', amount: p.amount });
  const replay = await app.inject({ method: 'POST', url: '/api/webhooks/payments/sandbox', payload: ev.raw, headers: ev.headers });
  assert.equal(replay.statusCode, 200);
  assert.equal(await balanceOf(c), 1_000_000, 'replayed webhook must not credit twice');

  const forged = sign({ paymentId: pid, status: 'succeeded', amount: p.amount }, 'x'.repeat(32));
  assert.equal((await app.inject({ method: 'POST', url: '/api/webhooks/payments/sandbox', payload: forged.raw, headers: forged.headers })).statusCode, 401);

  await deposit(c, 500_000, true);
  assert.equal((await c.get('/api/me')).body.bonusBalance, 1_000_000, 'welcome bonus only once');
});

test('casino: slot, roulette, dice debit and credit through the ledger; insufficient funds blocked', async () => {
  const c = client(app); await register(c);
  assert.equal((await c.post('/api/games/slot', { bet: 10000 })).body.error, 'INSUFFICIENT_FUNDS');
  await deposit(c, 1_000_000);
  let bal = 1_000_000;
  for (let i = 0; i < 20; i++) {
    const r = await c.post('/api/games/slot', { bet: 10000 });
    assert.equal(r.status, 200);
    bal = bal - 10000 + r.body.payout;
    assert.equal(r.body.balance, bal);
  }
  const ro = await c.post('/api/games/roulette', { bets: { red: 10000, n17: 10000 } });
  assert.equal(ro.status, 200);
  const n = ro.body.result.number;
  assert.equal(ro.body.payout, (M.REDS.has(n) ? 20000 : 0) + (n === 17 ? 360000 : 0));
  assert.equal((await c.post('/api/games/roulette', { bets: { bogus: 100 } })).status, 400);
  const d = await c.post('/api/games/dice', { bet: 10000, chance: 49.5 });
  assert.equal(d.body.payout, d.body.result.won ? Math.floor(10000 * 1.9797) : 0);
  assert.equal((await c.post('/api/games/dice', { bet: 10000, chance: 99 })).status, 400);
  assert.equal((await c.post('/api/games/slot', { bet: 99 })).body.error, 'BET_TOO_SMALL');
});

test('provably fair: revealed seed reproduces every outcome', async () => {
  const c = client(app); await register(c); await deposit(c, 1_000_000);
  const before = (await c.get('/api/fair')).body.current;
  const spin = await c.post('/api/games/dice', { bet: 10000, chance: 50 });
  const rot = await c.post('/api/fair/rotate', { clientSeed: 'my-seed' });
  assert.equal(crypto.createHash('sha256').update(rot.body.revealed.serverSeed).digest('hex'), before.serverHash);
  const f = floatsFor(rot.body.revealed.serverSeed, rot.body.revealed.clientSeed, spin.body.nonce, 1);
  assert.equal(M.diceRoll(f[0]), spin.body.result.roll);
  assert.equal(rot.body.current.clientSeed, 'my-seed');
});

test('mines: cannot rotate seed mid-round; cash-out pays the table multiplier', async () => {
  const c = client(app); await register(c); await deposit(c, 1_000_000);
  const s = await c.post('/api/games/mines/start', { bet: 100000, mines: 1 });
  assert.equal(s.status, 200);
  assert.equal((await c.post('/api/fair/rotate', {})).body.error, 'ROUND_OPEN');
  const mine = (await pool.query(`SELECT state FROM game_rounds WHERE id=$1`, [s.body.roundId])).rows[0].state.mines[0];
  const safe = [...Array(25).keys()].filter(i => i !== mine).slice(0, 3);
  for (const t of safe) assert.equal((await c.post('/api/games/mines/reveal', { tile: t })).status, 200);
  const out = await c.post('/api/games/mines/cashout');
  assert.equal(out.body.payout, M.payoutOf(100000, M.minesMultiplier(1, 3)));
  assert.equal(await balanceOf(c), 1_000_000 - 100000 + out.body.payout);
});

test('crash: server clock decides; auto cash-out is honoured; early cash-out rejected', async () => {
  const c = client(app); await register(c); await deposit(c, 1_000_000);
  const s = await c.post('/api/games/crash/start', { bet: 100000, auto: 1.01 });
  assert.equal(s.status, 200);
  const r = (await pool.query(`SELECT state FROM game_rounds WHERE id=$1`, [s.body.roundId])).rows[0];
  // Force the round into the past so it is settleable deterministically.
  await pool.query(`UPDATE game_rounds SET state = jsonb_set(state,'{startedAt}', to_jsonb($2::bigint)) WHERE id=$1`, [s.body.roundId, Date.now() - 600_000]);
  const st = await c.get('/api/games/crash');
  assert.equal(st.body.open, false);
  assert.equal(st.body.payout, r.state.point > 1.01 ? 101000 : 0);

  await c.post('/api/games/crash/start', { bet: 100000 });
  const early = await c.post('/api/games/crash/cashout');
  assert.equal(early.body.error, 'TOO_EARLY');
});

test('sportsbook: odds-change protection, express settlement, void refunds', async () => {
  const c = client(app); await register(c); await deposit(c, 1_000_000);
  const { svc } = app.ctx;
  const mk = p => svc.sport.create({ sport: 'football', league: 'Test', home: 'A', away: 'B', startsAt: new Date(Date.now() + 3600e3).toISOString(), probs: p, margin: 0.05 });
  const e1 = await mk([0.5, 0.25, 0.25]), e2 = await mk([0.4, 0.3, 0.3]), e3 = await mk([0.6, 0.2, 0.2]);
  const hi = await c.post('/api/sport/bets', { kind: 'single', stake: 10000, selections: [{ eventId: e1.id, outcome: 0, odds: e1.odds[0] + 0.5 }] });
  assert.equal(hi.body.error, 'ODDS_CHANGED');
  const acc = await c.post('/api/sport/bets', { kind: 'express', stake: 10000, selections: [
    { eventId: e1.id, outcome: 0, odds: e1.odds[0] }, { eventId: e2.id, outcome: 2, odds: e2.odds[2] }] });
  assert.equal(acc.status, 200);
  const single = await c.post('/api/sport/bets', { kind: 'single', stake: 10000, selections: [{ eventId: e3.id, outcome: 1, odds: e3.odds[1] }] });
  assert.equal(single.status, 200);
  await svc.sport.settle(e1.id, { result: 0 });
  let bets = (await c.get('/api/sport/bets')).body;
  assert.equal(bets.find(b => b.id === acc.body.betIds[0]).status, 'pending', 'express waits for all legs');
  await svc.sport.settle(e2.id, { cancel: true });
  bets = (await c.get('/api/sport/bets')).body;
  const a = bets.find(b => b.id === acc.body.betIds[0]);
  assert.equal(a.status, 'won');
  assert.equal(a.payout, Math.floor(10000 * e1.odds[0]), 'void leg counts as 1.00');
  await svc.sport.settle(e3.id, { cancel: true });
  assert.equal((await c.get('/api/sport/bets')).body.find(b => b.id === single.body.betIds[0]).status, 'void');
  assert.equal(await balanceOf(c), 1_000_000 - 20000 + Math.floor(10000 * e1.odds[0]) + 10000);
});

test('responsible gaming: limit decreases apply now, increases wait 24h; self-exclusion blocks play', async () => {
  const c = client(app); await register(c); await deposit(c, 1_000_000);
  let r = await c.post('/api/me/limits', { depositDaily: 2_000_000 });
  assert.deepEqual(r.body.applied, ['deposit_daily']);
  r = await c.post('/api/me/limits', { depositDaily: 5_000_000 });
  assert.deepEqual(r.body.pending, ['deposit_daily']);
  assert.equal(r.body.limits.depositDaily, 2_000_000);
  const over = await c.post('/api/wallet/deposit', { provider: 'sandbox', method: 'card', amount: 1_500_000 });
  assert.equal(over.body.error, 'DEPOSIT_LIMIT');
  await c.post('/api/me/limits', { selfExcludeDays: 1 });
  assert.equal((await c.post('/api/games/slot', { bet: 10000 })).body.error, 'SELF_EXCLUDED');
});

test('withdrawals: KYC + turnover required, hold → finance approval → paid; viewer cannot approve', async () => {
  const c = client(app); const reg = await register(c); await deposit(c, 1_000_000, false, '5555');
  const w = { provider: 'sandbox', method: 'card', instrument: 'card:••5555', amount: 300_000 };
  assert.equal((await c.post('/api/wallet/withdraw', w)).body.error, 'KYC_REQUIRED');
  await pool.query(`UPDATE users SET kyc_status='verified' WHERE public_id=$1`, [reg.body.user.id]);
  assert.equal((await c.post('/api/wallet/withdraw', w)).body.error, 'TURNOVER');
  for (let i = 0; i < 10; i++) await c.post('/api/games/dice', { bet: 100000, chance: 95 });
  const bal = await balanceOf(c);
  const wr = await c.post('/api/wallet/withdraw', w);
  assert.equal(wr.status, 200);
  assert.equal(wr.body.balance, bal - 300_000);

  const pii = makePii(cfg.PII_KEY, cfg.LOOKUP_KEY);
  const mkStaff = async (email, role) => {
    const secret = 'JBSWY3DPEHPK3PXP';
    await pool.query(`INSERT INTO staff (email, name, password_hash, role, totp_secret_enc) VALUES ($1,$2,$3,$4,$5)`,
      [email, role, await hash('staff-password-123'), role, pii.enc(secret)]);
    const s = client(app);
    const bad = await s.post('/api/admin/login', { email, password: 'staff-password-123', totp: '000000' });
    assert.equal(bad.status, 401, '2FA is mandatory');
    const ok = await s.post('/api/admin/login', { email, password: 'staff-password-123', totp: totpCode(secret) });
    assert.equal(ok.status, 200);
    return s;
  };
  const viewer = await mkStaff('viewer@noir.test', 'viewer');
  assert.equal((await viewer.post(`/api/admin/withdrawals/${wr.body.paymentId}/approve`, {})).status, 403);
  const players = (await viewer.get('/api/admin/players')).body;
  assert.ok(players.every(p => p.birthDate === null), 'viewer does not see personal data');

  const fin = await mkStaff('finance@noir.test', 'finance');
  assert.equal((await fin.post(`/api/admin/withdrawals/${wr.body.paymentId}/approve`, { note: 'ok' })).status, 200);
  const p = (await pool.query('SELECT * FROM payments WHERE id=$1', [wr.body.paymentId])).rows[0];
  const ev = sign({ paymentId: p.id, providerRef: p.provider_ref, status: 'paid', amount: p.amount });
  await app.inject({ method: 'POST', url: '/api/webhooks/payments/sandbox', payload: ev.raw, headers: ev.headers });
  assert.equal((await pool.query('SELECT status FROM payments WHERE id=$1', [p.id])).rows[0].status, 'paid');
  assert.equal((await c.get('/api/me')).body.pendingWithdrawals, 0);
  const audit = (await pool.query(`SELECT action FROM audit_log WHERE action='withdrawal_approve'`)).rows;
  assert.equal(audit.length, 1);
});

test('back office dashboard and ledger integrity', async () => {
  const pii = makePii(cfg.PII_KEY, cfg.LOOKUP_KEY);
  await pool.query(`INSERT INTO staff (email, name, password_hash, role, totp_secret_enc) VALUES ('boss@noir.test','Boss',$1,'admin',$2)`,
    [await hash('staff-password-123'), pii.enc('JBSWY3DPEHPK3PXP')]);
  const s = client(app);
  await s.post('/api/admin/login', { email: 'boss@noir.test', password: 'staff-password-123', totp: totpCode('JBSWY3DPEHPK3PXP') });
  const d = await s.get('/api/admin/dashboard?days=7');
  assert.equal(d.status, 200);
  assert.equal(d.body.ledgerOk, true);
  assert.ok(d.body.money.deposits > 0);
  assert.ok(d.body.games.some(g => g.game === 'slot'));
  await assert.rejects(pool.query('UPDATE ledger SET amount = amount + 1'), /append-only/);
  await assert.rejects(pool.query('DELETE FROM audit_log'), /append-only/);
  const m = await app.inject({ method: 'GET', url: '/metrics' });
  assert.equal(m.statusCode, 401);
  const m2 = await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: `Bearer ${cfg.METRICS_TOKEN}` } });
  assert.match(m2.body, /noir_bets_total/);
});
