import { z } from 'zod';
import crypto from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { parse, fail } from '../lib/errors.js';
import { tx } from '../lib/db.js';
import { balances, openAccounts } from '../lib/ledger.js';
import { activeSeed, publicSeed, rotate } from '../lib/fair.js';
import { getLimits, setLimits } from '../lib/rg.js';
import { onRegister } from '../lib/aml.js';
import { metrics } from '../lib/metrics.js';
import { RTP } from '../games/math.js';

const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 }; // OWASP 2024 baseline for argon2id
const DUMMY_HASH = await hash('timing-equaliser', ARGON);
const money = z.number().int().positive().max(1e14);

export default async function playerRoutes(app) {
  const { cfg, pool, pii, sessions, audit, svc } = app.ctx;

  // Pre-auth endpoints: a custom header forces a CORS preflight, which blocks cross-site form posts.
  const sameOrigin = async req => { if (req.headers['x-requested-with'] !== 'noir') fail('CSRF', 'Запрос отклонён', 403); };

  const requireUser = async (req) => {
    const s = await sessions.load(req, 'player');
    if (!s) fail('AUTH', 'Войдите в аккаунт', 401);
    sessions.checkCsrf(req, s);
    const u = (await pool.query('SELECT * FROM users WHERE id = $1', [s.user_id])).rows[0];
    if (!u || u.status === 'closed') fail('AUTH', 'Войдите в аккаунт', 401);
    req.session = s; req.user = u;
  };

  async function profile(userId, csrf) {
    const u = (await pool.query('SELECT * FROM users WHERE id=$1', [userId])).rows[0];
    const [bal, limits, bonus] = await Promise.all([
      balances(pool, userId),
      tx(pool, c => getLimits(c, userId)),
      pool.query(`SELECT amount, wager_req, wagered, expires_at FROM bonuses WHERE user_id=$1 AND status='active'`, [userId]),
    ]);
    return {
      csrf, user: { id: u.public_id, name: pii.dec(u.email_enc) || pii.dec(u.phone_enc) || 'ID ' + u.public_id, currency: u.currency,
        kycStatus: u.kyc_status, status: u.status, since: u.created_at },
      balance: bal.cash, bonusBalance: bal.bonus, pendingWithdrawals: bal.withdraw_hold,
      bonus: bonus.rows[0] || null,
      limits: { depositDaily: limits.deposit_daily, depositWeekly: limits.deposit_weekly, depositMonthly: limits.deposit_monthly,
        lossDaily: limits.loss_daily, realityCheckMin: limits.reality_check_min, selfExcludedUntil: limits.self_excluded_until,
        pending: limits.pending, pendingEffectiveAt: limits.pending_effective_at },
    };
  }

  app.get('/config', async () => ({
    sandbox: cfg.PAYMENT_PROVIDERS.includes('sandbox'), currency: cfg.CURRENCY, minBet: cfg.MIN_BET, maxBet: cfg.MAX_BET, methods: svc.payments.methods(), rtp: RTP,
    bonus: { pct: cfg.WELCOME_BONUS_PCT, max: cfg.WELCOME_BONUS_MAX, wager: cfg.BONUS_WAGER, days: cfg.BONUS_DAYS },
  }));

  /* ---------------- auth ---------------- */
  const authLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.post('/auth/register', { ...authLimit, preHandler: sameOrigin }, async (req, reply) => {
    const b = parse(z.object({
      method: z.enum(['oneclick', 'phone', 'email']),
      email: z.string().max(200).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'неверный e-mail').optional(),
      phone: z.string().max(30).regex(/^\+?[0-9\s()-]{10,20}$/, 'неверный номер').optional(),
      password: z.string().min(10, 'минимум 10 символов').max(200).optional(),
      birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'формат ГГГГ-ММ-ДД'),
      currency: z.enum(['KZT', 'RUB', 'USD', 'UZS']).default('KZT'),
      bonusPref: z.enum(['casino', 'sport', 'none']).default('casino'),
      acceptTerms: z.literal(true, { message: 'нужно принять правила' }),
    }), req.body);
    const bd = new Date(b.birthDate + 'T00:00:00Z');
    const adult = new Date(bd); adult.setUTCFullYear(adult.getUTCFullYear() + 18);
    if (isNaN(bd) || adult > new Date()) fail('AGE', 'Регистрация доступна только с 18 лет', 403);
    if (b.method === 'email' && (!b.email || !b.password)) fail('VALIDATION', 'Укажите e-mail и пароль', 400);
    if (b.method === 'phone' && (!b.phone || !b.password)) fail('VALIDATION', 'Укажите телефон и пароль', 400);
    const phone = b.phone ? '+' + b.phone.replace(/\D/g, '') : null;
    const password = b.method === 'oneclick' ? crypto.randomBytes(9).toString('base64url') : b.password;
    const pwHash = await hash(password, ARGON);
    const country = String(req.headers[cfg.COUNTRY_HEADER] || '').toUpperCase().slice(0, 2) || null;

    const user = await tx(pool, async c => {
      if (b.email && (await c.query('SELECT 1 FROM users WHERE email_hash=$1', [pii.lookup(b.email)])).rowCount) fail('EXISTS', 'Этот e-mail уже зарегистрирован', 409);
      if (phone && (await c.query('SELECT 1 FROM users WHERE phone_hash=$1', [pii.lookup(phone)])).rowCount) fail('EXISTS', 'Этот номер уже зарегистрирован', 409);
      let u;
      for (let i = 0; i < 5 && !u; i++) {
        const pid = String(crypto.randomInt(100_000_000, 999_999_999));
        u = (await c.query(`INSERT INTO users (public_id, email_hash, email_enc, phone_hash, phone_enc, password_hash, birth_date_enc, currency, country, bonus_pref, reg_ip, last_ip)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) ON CONFLICT (public_id) DO NOTHING RETURNING *`,
          [pid, pii.lookup(b.email), pii.enc(b.email?.trim()), pii.lookup(phone), pii.enc(phone), pwHash, pii.enc(b.birthDate), b.currency, country, b.bonusPref, req.ip])).rows[0];
      }
      await openAccounts(c, u.id, b.currency);
      await onRegister(c, u, req.ip);
      await audit(c, { actorType: 'user', actorId: u.id, action: 'register', ip: req.ip, details: { method: b.method } });
      return u;
    });
    metrics.registrations.inc();
    const csrf = await sessions.create(reply, req, { userId: user.id });
    return { ...(await profile(user.id, csrf)), credentials: b.method === 'oneclick' ? { id: user.public_id, password } : undefined };
  });

  app.post('/auth/login', { ...authLimit, preHandler: sameOrigin }, async (req, reply) => {
    const b = parse(z.object({ login: z.string().min(3).max(200), password: z.string().min(1).max(200) }), req.body);
    const login = b.login.trim();
    let u;
    if (/^\d{9}$/.test(login)) u = (await pool.query('SELECT * FROM users WHERE public_id=$1', [login])).rows[0];
    else if (login.includes('@')) u = (await pool.query('SELECT * FROM users WHERE email_hash=$1', [pii.lookup(login)])).rows[0];
    else u = (await pool.query('SELECT * FROM users WHERE phone_hash=$1', [pii.lookup('+' + login.replace(/\D/g, ''))])).rows[0];
    if (u?.locked_until && u.locked_until > new Date()) fail('LOCKED', 'Слишком много попыток. Попробуйте через 15 минут.', 429);
    const ok = await verify(u?.password_hash || DUMMY_HASH, b.password);
    if (!u || !ok || u.status === 'closed') {
      if (u) await pool.query(`UPDATE users SET failed_logins = failed_logins + 1,
        locked_until = CASE WHEN failed_logins + 1 >= 5 THEN now() + interval '15 minutes' ELSE locked_until END
        WHERE id=$1`, [u.id]);
      metrics.logins.inc({ kind: 'player', result: 'fail' });
      fail('BAD_LOGIN', 'Неверный логин или пароль', 401);
    }
    await pool.query(`UPDATE users SET failed_logins=0, locked_until=NULL, last_login_at=now(), last_ip=$2 WHERE id=$1`, [u.id, req.ip]);
    await audit(null, { actorType: 'user', actorId: u.id, action: 'login', ip: req.ip });
    metrics.logins.inc({ kind: 'player', result: 'ok' });
    return profile(u.id, await sessions.create(reply, req, { userId: u.id }));
  });

  app.post('/auth/logout', { preHandler: requireUser }, async (req, reply) => { await sessions.revoke(req, reply, 'player'); return { ok: true }; });

  /* ---------------- profile & responsible gaming ---------------- */
  app.get('/me', async (req) => {
    const s = await sessions.load(req, 'player');
    if (!s) return { user: null };
    return profile(s.user_id, s.csrf_token);
  });

  app.post('/me/password', { preHandler: requireUser, ...authLimit }, async (req, reply) => {
    const b = parse(z.object({ current: z.string().max(200), next: z.string().min(10, 'минимум 10 символов').max(200) }), req.body);
    if (!(await verify(req.user.password_hash, b.current))) fail('BAD_LOGIN', 'Текущий пароль неверен', 401);
    await pool.query('UPDATE users SET password_hash=$2 WHERE id=$1', [req.user.id, await hash(b.next, ARGON)]);
    await sessions.revokeAllFor('user', req.user.id);
    await audit(null, { actorType: 'user', actorId: req.user.id, action: 'password_change', ip: req.ip });
    return profile(req.user.id, await sessions.create(reply, req, { userId: req.user.id }));
  });

  app.post('/me/limits', { preHandler: requireUser }, async (req) => {
    const opt = z.number().int().min(0).max(1e14).nullable().optional();
    const b = parse(z.object({ depositDaily: opt, depositWeekly: opt, depositMonthly: opt, lossDaily: opt,
      realityCheckMin: z.number().int().min(0).max(240).nullable().optional(), selfExcludeDays: z.union([z.literal(1), z.literal(7), z.literal(30), z.literal(180)]).optional() }), req.body);
    const map = { depositDaily: 'deposit_daily', depositWeekly: 'deposit_weekly', depositMonthly: 'deposit_monthly', lossDaily: 'loss_daily', realityCheckMin: 'reality_check_min' };
    const input = {}; for (const [k, v] of Object.entries(map)) if (k in b) input[v] = b[k];
    if (b.selfExcludeDays) input.self_exclude_days = b.selfExcludeDays;
    const r = await tx(pool, async c => {
      const out = await setLimits(c, req.user.id, input);
      await audit(c, { actorType: 'user', actorId: req.user.id, action: 'limits_change', ip: req.ip, details: { ...b } });
      return out;
    });
    return { ...r, ...(await profile(req.user.id, req.session.csrf_token)) };
  });

  /* ---------------- wallet ---------------- */
  app.get('/wallet/history', { preHandler: requireUser }, async (req) => {
    const r = await pool.query(`SELECT id, account_kind, type, amount, balance_after, ref_type, ref_id, meta, created_at FROM ledger
      WHERE user_id=$1 ORDER BY id DESC LIMIT 100`, [req.user.id]);
    const p = await pool.query(`SELECT id, direction, provider, method, amount, status, created_at, updated_at FROM payments WHERE user_id=$1 ORDER BY id DESC LIMIT 50`, [req.user.id]);
    return { ledger: r.rows, payments: p.rows };
  });

  app.post('/wallet/deposit', { preHandler: requireUser }, async (req) => {
    const b = parse(z.object({ provider: z.string().max(40), method: z.string().max(40), amount: money, withBonus: z.boolean().optional(),
      idempotencyKey: z.string().max(80).optional() }), req.body);
    return svc.payments.createDeposit(req.user, b);
  });

  app.post('/wallet/withdraw', { preHandler: requireUser }, async (req) => {
    const b = parse(z.object({ provider: z.string().max(40), method: z.string().max(40), amount: money }), req.body);
    return svc.payments.requestWithdrawal(req.user, b);
  });
  app.post('/wallet/withdraw/:id/cancel', { preHandler: requireUser }, async (req) => svc.payments.cancelWithdrawal(req.user.id, Number(req.params.id)));

  /* ---------------- KYC ---------------- */
  app.post('/kyc/start', { preHandler: requireUser }, async (req) => {
    if (req.user.kyc_status === 'verified') return { status: 'verified' };
    await pool.query(`UPDATE users SET kyc_status='pending' WHERE id=$1 AND kyc_status IN ('none','rejected')`, [req.user.id]);
    await audit(null, { actorType: 'user', actorId: req.user.id, action: 'kyc_start', ip: req.ip });
    // Production: return the KYC provider's hosted flow URL (Sumsub / Veriff / Onfido) here.
    return { status: 'pending', message: 'Заявка на проверку отправлена. Обычно это занимает до 24 часов.' };
  });

  /* ---------------- provably fair ---------------- */
  app.get('/fair', { preHandler: requireUser }, async (req) => {
    const s = await tx(pool, c => activeSeed(c, req.user.id));
    const prev = (await pool.query(`SELECT server_seed, server_hash, client_seed, nonce, revealed_at FROM fair_seeds
      WHERE user_id=$1 AND NOT active ORDER BY id DESC LIMIT 5`, [req.user.id])).rows;
    return { current: publicSeed(s), revealed: prev };
  });
  app.post('/fair/rotate', { preHandler: requireUser }, async (req) => {
    const b = parse(z.object({ clientSeed: z.string().regex(/^[\w-]{1,64}$/, 'латиница, цифры, - и _').optional() }), req.body);
    const r = await tx(pool, c => rotate(c, req.user.id, b.clientSeed));
    const s = await tx(pool, c => activeSeed(c, req.user.id));
    return { ...r, current: publicSeed(s) };
  });

  /* ---------------- casino ---------------- */
  const gameLimit = { preHandler: requireUser, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };
  app.post('/games/slot', gameLimit, async req => svc.casino.slot(req.user.id, parse(z.object({ bet: money }), req.body).bet));
  app.post('/games/roulette', gameLimit, async req => svc.casino.roulette(req.user.id, parse(z.object({ bets: z.record(z.string(), money) }), req.body).bets));
  app.post('/games/dice', gameLimit, async req => { const b = parse(z.object({ bet: money, chance: z.number() }), req.body); return svc.casino.dice(req.user.id, b.bet, b.chance); });
  app.get('/games/mines', { preHandler: requireUser }, async req => ({ round: await svc.casino.minesState(req.user.id) }));
  app.post('/games/mines/start', gameLimit, async req => { const b = parse(z.object({ bet: money, mines: z.number().int() }), req.body); return svc.casino.minesStart(req.user.id, b.bet, b.mines); });
  app.post('/games/mines/reveal', gameLimit, async req => svc.casino.minesReveal(req.user.id, parse(z.object({ tile: z.number().int() }), req.body).tile));
  app.post('/games/mines/cashout', gameLimit, async req => svc.casino.minesCashout(req.user.id));
  app.post('/games/crash/start', gameLimit, async req => { const b = parse(z.object({ bet: money, auto: z.number().nullable().optional() }), req.body); return svc.casino.crashStart(req.user.id, b.bet, b.auto ?? null); });
  app.post('/games/crash/cashout', gameLimit, async req => svc.casino.crashCashout(req.user.id));
  app.get('/games/crash', { preHandler: requireUser }, async req => svc.casino.crashStatus(req.user.id));
  app.get('/games/history', { preHandler: requireUser }, async req => (await pool.query(
    `SELECT id, game, bet, payout, status, nonce, result, created_at FROM game_rounds WHERE user_id=$1 AND status='settled' ORDER BY id DESC LIMIT 50`, [req.user.id])).rows);

  /* ---------------- sportsbook ---------------- */
  app.get('/sport/events', async () => svc.sport.list());
  app.post('/sport/bets', gameLimit, async req => {
    const b = parse(z.object({ kind: z.enum(['single', 'express']), stake: money,
      selections: z.array(z.object({ eventId: z.number().int(), outcome: z.number().int(), odds: z.number() })).min(1).max(20) }), req.body);
    return svc.sport.place(req.user.id, b);
  });
  app.get('/sport/bets', { preHandler: requireUser }, async req => svc.sport.myBets(req.user.id));
}
