// Back office API. Staff sessions are separate from player sessions, 2FA (TOTP) is mandatory,
// every data access to personal data and every action is written to the append-only audit log.
import { z } from 'zod';
import crypto from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { parse, fail } from '../lib/errors.js';
import { tx } from '../lib/db.js';
import { post, balances, reconcile } from '../lib/ledger.js';
import { totpVerify, base32Encode } from '../lib/crypto.js';
import { metrics } from '../lib/metrics.js';
import { RTP } from '../games/math.js';

const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 };
const DUMMY = await hash('timing-equaliser', ARGON);
const PII_ROLES = ['admin', 'support', 'risk', 'finance'];

export default async function adminRoutes(app) {
  const { cfg, pool, pii, sessions, audit, svc } = app.ctx;

  const auth = (...roles) => async (req) => {
    const s = await sessions.load(req, 'staff');
    if (!s) fail('AUTH', 'Войдите в бэк-офис', 401);
    sessions.checkCsrf(req, s);
    const st = (await pool.query('SELECT id, email, name, role, active FROM staff WHERE id=$1', [s.staff_id])).rows[0];
    if (!st?.active) fail('AUTH', 'Доступ отключён', 401);
    if (roles.length && !roles.includes(st.role)) fail('FORBIDDEN', 'Недостаточно прав для этого действия', 403);
    req.staff = st; req.session = s;
  };
  const log = (req, action, targetType, targetId, details) =>
    audit(null, { actorType: 'staff', actorId: req.staff.id, action, targetType, targetId, ip: req.ip, details });

  app.post('/login', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (req.headers['x-requested-with'] !== 'noir') fail('CSRF', 'Запрос отклонён', 403);
    const b = parse(z.object({ email: z.string().max(200), password: z.string().max(200), totp: z.string().max(6) }), req.body);
    const st = (await pool.query('SELECT * FROM staff WHERE email=$1', [b.email.trim().toLowerCase()])).rows[0];
    if (st?.locked_until && st.locked_until > new Date()) fail('LOCKED', 'Учётная запись временно заблокирована', 429);
    const ok = (await verify(st?.password_hash || DUMMY, b.password)) && st?.active && totpVerify(pii.dec(st.totp_secret_enc), b.totp);
    if (!ok) {
      if (st) await pool.query(`UPDATE staff SET failed_logins=failed_logins+1, locked_until = CASE WHEN failed_logins+1 >= 5 THEN now()+interval '30 minutes' ELSE locked_until END WHERE id=$1`, [st.id]);
      metrics.logins.inc({ kind: 'staff', result: 'fail' });
      await audit(null, { actorType: 'system', action: 'staff_login_failed', ip: req.ip, details: { email: b.email.slice(0, 100) } });
      fail('BAD_LOGIN', 'Неверные данные для входа', 401);
    }
    await pool.query('UPDATE staff SET failed_logins=0, locked_until=NULL WHERE id=$1', [st.id]);
    const csrf = await sessions.create(reply, req, { staffId: st.id });
    await audit(null, { actorType: 'staff', actorId: st.id, action: 'staff_login', ip: req.ip });
    metrics.logins.inc({ kind: 'staff', result: 'ok' });
    return { csrf, staff: { name: st.name, email: st.email, role: st.role } };
  });

  app.get('/me', async (req) => {
    const s = await sessions.load(req, 'staff');
    if (!s) return { staff: null };
    const st = (await pool.query('SELECT name, email, role, active FROM staff WHERE id=$1', [s.staff_id])).rows[0];
    return st?.active ? { csrf: s.csrf_token, staff: st } : { staff: null };
  });
  app.post('/logout', { preHandler: auth() }, async (req, reply) => { await sessions.revoke(req, reply, 'staff'); return { ok: true }; });

  /* ---------------- dashboard ---------------- */
  app.get('/dashboard', { preHandler: auth() }, async (req) => {
    const days = [1, 7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 7;
    const since = `now() - interval '${days} days'`;
    const q = sql => pool.query(sql).then(r => r.rows);
    const [money] = await q(`SELECT
        COALESCE(SUM(-amount) FILTER (WHERE type='bet' AND ref_type='round'),0)::bigint AS casino_stake,
        COALESCE(SUM(amount)  FILTER (WHERE type='win' AND ref_type='round'),0)::bigint AS casino_payout,
        COALESCE(SUM(-amount) FILTER (WHERE type='bet' AND ref_type='sport_bet'),0)::bigint AS sport_stake,
        COALESCE(SUM(amount)  FILTER (WHERE type IN ('win','refund') AND ref_type='sport_bet'),0)::bigint AS sport_payout,
        COALESCE(SUM(amount)  FILTER (WHERE type IN ('bonus_release','cashback') AND account_kind='cash'),0)::bigint AS bonus_cost,
        COALESCE(SUM(-amount) FILTER (WHERE type='chargeback'),0)::bigint AS chargebacks_recovered,
        COALESCE(SUM(amount)  FILTER (WHERE type='deposit'),0)::bigint AS deposits,
        COALESCE(SUM(-amount) FILTER (WHERE type='withdrawal_paid'),0)::bigint AS withdrawals,
        COUNT(DISTINCT user_id) FILTER (WHERE type='bet') AS active_players
      FROM ledger WHERE created_at >= ${since}`);
    const [players] = await q(`SELECT COUNT(*) FILTER (WHERE created_at >= ${since}) AS new_players, COUNT(*) AS total_players,
        COUNT(*) FILTER (WHERE kyc_status='pending') AS kyc_pending FROM users`);
    const [ops] = await q(`SELECT
        (SELECT COUNT(*) FROM payments WHERE direction='withdrawal' AND status='review') AS withdrawals_review,
        (SELECT COALESCE(SUM(amount),0)::bigint FROM payments WHERE direction='withdrawal' AND status='review') AS withdrawals_review_sum,
        (SELECT COUNT(*) FROM aml_alerts WHERE status='open') AS aml_open,
        (SELECT COUNT(*) FROM aml_alerts WHERE status='open' AND severity='high') AS aml_high,
        (SELECT COALESCE(SUM(balance),0)::bigint FROM accounts WHERE kind='cash') AS player_liability,
        (SELECT COUNT(*) FROM sport_bets WHERE status='pending') AS sport_open_bets,
        (SELECT COALESCE(SUM(stake),0)::bigint FROM sport_bets WHERE status='pending') AS sport_open_stake`);
    const games = await q(`SELECT game, COUNT(*)::int AS rounds, SUM(bet)::bigint AS stake, SUM(payout)::bigint AS payout,
        COUNT(DISTINCT user_id)::int AS players FROM game_rounds WHERE status='settled' AND created_at >= ${since} GROUP BY game ORDER BY stake DESC`);
    const daily = await q(`SELECT date_trunc('day', created_at)::date AS day,
        COALESCE(SUM(-amount) FILTER (WHERE type='bet'),0)::bigint - COALESCE(SUM(amount) FILTER (WHERE type IN ('win','refund')),0)::bigint AS ggr,
        COALESCE(SUM(amount) FILTER (WHERE type='deposit'),0)::bigint AS deposits
      FROM ledger WHERE created_at >= ${since} GROUP BY 1 ORDER BY 1`);
    const mismatches = await reconcile(pool);
    return {
      days, money: { ...money, ggr_casino: money.casino_stake - money.casino_payout, ggr_sport: money.sport_stake - money.sport_payout,
        ngr: money.casino_stake - money.casino_payout + money.sport_stake - money.sport_payout - money.bonus_cost },
      players, ops, daily,
      games: games.map(g => ({ ...g, rtp_actual: g.stake ? g.payout / g.stake : null, rtp_theoretical: RTP[g.game] ?? null })),
      ledgerOk: mismatches.length === 0, ledgerMismatches: mismatches.slice(0, 20),
    };
  });

  /* ---------------- players ---------------- */
  const view = (st, u) => {
    const canPii = PII_ROLES.includes(st.role);
    const mask = v => (v ? v.replace(/^(.{2}).*(.{2})$/, '$1•••$2') : null);
    const email = pii.dec(u.email_enc), phone = pii.dec(u.phone_enc);
    return { id: u.id, publicId: u.public_id, email: canPii ? email : mask(email), phone: canPii ? phone : mask(phone),
      birthDate: canPii ? pii.dec(u.birth_date_enc) : null, currency: u.currency, country: u.country, status: u.status, kycStatus: u.kyc_status,
      stakeFactor: u.stake_factor, totpEnabled: u.totp_enabled, securityHoldUntil: u.security_hold_until,
      regIp: canPii ? u.reg_ip : null, lastIp: canPii ? u.last_ip : null, lastLoginAt: u.last_login_at, createdAt: u.created_at };
  };

  app.get('/players', { preHandler: auth() }, async (req) => {
    const q = String(req.query.q || '').trim();
    let rows;
    if (!q) rows = (await pool.query(`SELECT u.*, a.balance FROM users u JOIN accounts a ON a.user_id=u.id AND a.kind='cash' ORDER BY u.id DESC LIMIT 100`)).rows;
    else rows = (await pool.query(`SELECT u.*, a.balance FROM users u JOIN accounts a ON a.user_id=u.id AND a.kind='cash'
      WHERE u.public_id=$1 OR u.email_hash=$2 OR u.phone_hash=$3 LIMIT 20`, [q, pii.lookup(q), pii.lookup('+' + q.replace(/\D/g, ''))])).rows;
    if (q) await log(req, 'player_search', null, null, { found: rows.length });
    return rows.map(u => ({ ...view(req.staff, u), balance: u.balance }));
  });

  app.get('/players/:id', { preHandler: auth() }, async (req) => {
    const id = Number(req.params.id);
    const u = (await pool.query('SELECT * FROM users WHERE id=$1', [id])).rows[0];
    if (!u) fail('NOT_FOUND', 'Игрок не найден', 404);
    await log(req, 'player_view', 'user', id);
    const [bal, ledger, rounds, bets, pays, alerts, limits, bonus, sess, stats] = await Promise.all([
      balances(pool, id),
      pool.query('SELECT * FROM ledger WHERE user_id=$1 ORDER BY id DESC LIMIT 100', [id]),
      pool.query('SELECT id, game, bet, payout, status, nonce, result, created_at FROM game_rounds WHERE user_id=$1 ORDER BY id DESC LIMIT 50', [id]),
      pool.query('SELECT * FROM sport_bets WHERE user_id=$1 ORDER BY id DESC LIMIT 50', [id]),
      pool.query('SELECT * FROM payments WHERE user_id=$1 ORDER BY id DESC LIMIT 50', [id]),
      pool.query('SELECT * FROM aml_alerts WHERE user_id=$1 ORDER BY id DESC', [id]),
      pool.query('SELECT * FROM limits WHERE user_id=$1', [id]),
      pool.query('SELECT * FROM bonuses WHERE user_id=$1 ORDER BY id DESC', [id]),
      pool.query('SELECT ip, user_agent, created_at, last_seen, revoked_at, expires_at FROM sessions WHERE user_id=$1 ORDER BY id DESC LIMIT 20', [id]),
      pool.query(`SELECT COALESCE(SUM(amount) FILTER (WHERE type='deposit'),0)::bigint AS deposits,
          COALESCE(SUM(-amount) FILTER (WHERE type='withdrawal_paid'),0)::bigint AS withdrawals,
          COALESCE(SUM(-amount) FILTER (WHERE type='bet'),0)::bigint AS stake,
          COALESCE(SUM(amount) FILTER (WHERE type IN ('win','refund')),0)::bigint AS payout FROM ledger WHERE user_id=$1`, [id]),
    ]);
    const canPii = PII_ROLES.includes(req.staff.role);
    return { player: view(req.staff, u), balances: bal, stats: stats.rows[0], ledger: ledger.rows, rounds: rounds.rows, sportBets: bets.rows,
      payments: pays.rows, alerts: alerts.rows, limits: limits.rows[0] || null, bonuses: bonus.rows,
      sessions: canPii ? sess.rows : sess.rows.map(s => ({ ...s, ip: null })) };
  });

  app.post('/players/:id/status', { preHandler: auth('admin', 'risk', 'support') }, async (req) => {
    const b = parse(z.object({ status: z.enum(['active', 'blocked', 'closed']), reason: z.string().min(3).max(500) }), req.body);
    const id = Number(req.params.id);
    const r = await pool.query('UPDATE users SET status=$2 WHERE id=$1 RETURNING id', [id, b.status]);
    if (!r.rowCount) fail('NOT_FOUND', 'Игрок не найден', 404);
    if (b.status !== 'active') await sessions.revokeAllFor('user', id);
    await log(req, 'player_status', 'user', id, b);
    return { ok: true };
  });

  app.post('/players/:id/kyc', { preHandler: auth('admin', 'risk', 'support') }, async (req) => {
    const b = parse(z.object({ status: z.enum(['none', 'pending', 'verified', 'rejected']), note: z.string().max(500).optional() }), req.body);
    // Manual verification unlocks withdrawals, so only the risk team (not first-line support) may grant it.
    if (b.status === 'verified' && !['admin', 'risk'].includes(req.staff.role)) fail('FORBIDDEN', 'Подтвердить верификацию может только риск-отдел', 403);
    const id = Number(req.params.id);
    await pool.query('UPDATE users SET kyc_status=$2 WHERE id=$1', [id, b.status]);
    await log(req, 'player_kyc', 'user', id, b);
    return { ok: true };
  });

  // Risk tool: limit (0 < f < 1) or disable (0) sports betting for arbitrage / sharp / bonus-abusing players.
  app.post('/players/:id/stake-factor', { preHandler: auth('admin', 'risk', 'trader') }, async (req) => {
    const b = parse(z.object({ factor: z.number().min(0).max(1), reason: z.string().min(3).max(500) }), req.body);
    const id = Number(req.params.id);
    await pool.query('UPDATE users SET stake_factor=$2 WHERE id=$1', [id, b.factor]);
    await log(req, 'player_stake_factor', 'user', id, b);
    return { ok: true };
  });

  app.post('/players/:id/adjust', { preHandler: auth('admin') }, async (req) => {
    const b = parse(z.object({ amount: z.number().int().refine(v => v !== 0, 'не может быть 0'), reason: z.string().min(5).max(500) }), req.body);
    const id = Number(req.params.id);
    const r = await tx(pool, async c => {
      const out = await post(c, { userId: id, type: 'adjustment', amount: b.amount, refType: 'staff', refId: req.staff.id, meta: { reason: b.reason } });
      await audit(c, { actorType: 'staff', actorId: req.staff.id, action: 'balance_adjust', targetType: 'user', targetId: id, ip: req.ip, details: b });
      return out;
    });
    return { balance: r.balance };
  });

  /* ---------------- payments ---------------- */
  app.get('/payments', { preHandler: auth('admin', 'finance', 'risk', 'viewer') }, async (req) => {
    const dir = ['deposit', 'withdrawal'].includes(req.query.direction) ? req.query.direction : null;
    const status = typeof req.query.status === 'string' && /^[a-z]+$/.test(req.query.status) ? req.query.status : null;
    return (await pool.query(`SELECT p.*, u.public_id, u.kyc_status FROM payments p JOIN users u ON u.id=p.user_id
      WHERE ($1::text IS NULL OR direction=$1) AND ($2::text IS NULL OR p.status=$2) ORDER BY p.id DESC LIMIT 200`, [dir, status])).rows;
  });
  app.post('/withdrawals/:id/:decision', { preHandler: auth('admin', 'finance') }, async (req) => {
    const decision = req.params.decision;
    if (!['approve', 'reject'].includes(decision)) fail('VALIDATION', 'approve или reject', 400);
    const b = parse(z.object({ note: z.string().max(500).optional() }), req.body);
    return svc.payments.review(req.staff, Number(req.params.id), decision, b.note, req.ip);
  });

  /* ---------------- AML ---------------- */
  app.get('/aml', { preHandler: auth('admin', 'risk') }, async (req) => {
    const status = req.query.status === 'closed' ? 'closed' : 'open';
    return (await pool.query(`SELECT a.*, u.public_id FROM aml_alerts a JOIN users u ON u.id=a.user_id WHERE a.status=$1
      ORDER BY (a.severity='high') DESC, a.id DESC LIMIT 200`, [status])).rows;
  });
  app.post('/aml/:id/close', { preHandler: auth('admin', 'risk') }, async (req) => {
    const b = parse(z.object({ note: z.string().min(3).max(1000) }), req.body);
    const id = Number(req.params.id);
    await pool.query(`UPDATE aml_alerts SET status='closed', closed_by=$2, note=$3, closed_at=now() WHERE id=$1`, [id, req.staff.id, b.note]);
    await log(req, 'aml_close', 'aml_alert', id, b);
    return { ok: true };
  });

  /* ---------------- sportsbook trading ---------------- */
  const prob3 = z.array(z.number().min(0).max(1)).length(3).refine(p => Math.abs(p.reduce((a, b) => a + b, 0) - 1) < 0.001, 'сумма вероятностей = 1');
  app.get('/events', { preHandler: auth() }, async () => (await pool.query(`SELECT e.*,
      (SELECT COUNT(*) FROM sport_selections s JOIN sport_bets b ON b.id=s.bet_id WHERE s.event_id=e.id AND b.status='pending')::int AS open_bets,
      (SELECT COALESCE(SUM(b.stake),0) FROM sport_selections s JOIN sport_bets b ON b.id=s.bet_id WHERE s.event_id=e.id AND b.status='pending')::bigint AS open_stake
    FROM sport_events e ORDER BY (status IN ('finished','cancelled')), starts_at LIMIT 300`)).rows);
  app.post('/events', { preHandler: auth('admin', 'trader') }, async (req) => {
    const b = parse(z.object({ sport: z.string().max(30), league: z.string().max(100), home: z.string().max(100), away: z.string().max(100),
      startsAt: z.string(), probs: prob3, margin: z.number().min(0).max(0.3) }), req.body);
    const e = await svc.sport.create(b);
    await log(req, 'event_create', 'sport_event', e.id, b);
    return e;
  });
  app.patch('/events/:id', { preHandler: auth('admin', 'trader') }, async (req) => {
    const b = parse(z.object({ probs: prob3.optional(), margin: z.number().min(0).max(0.3).optional(),
      status: z.enum(['scheduled', 'live', 'suspended']).optional(), clock: z.string().max(30).optional(),
      score: z.array(z.number().int().min(0)).length(2).optional() }), req.body);
    const e = await svc.sport.update(Number(req.params.id), b);
    await log(req, 'event_update', 'sport_event', e.id, b);
    return e;
  });
  app.post('/events/:id/settle', { preHandler: auth('admin', 'trader') }, async (req) => {
    const b = parse(z.object({ result: z.number().int().min(0).max(2).optional(), cancel: z.boolean().optional() }), req.body);
    if (b.result === undefined && !b.cancel) fail('VALIDATION', 'Укажите итог или отмену', 400);
    const r = await svc.sport.settle(Number(req.params.id), b);
    await log(req, 'event_settle', 'sport_event', Number(req.params.id), { ...b, ...r });
    return r;
  });

  /* ---------------- audit, reconciliation, staff ---------------- */
  app.get('/audit', { preHandler: auth('admin') }, async (req) => (await pool.query(`SELECT a.*, s.email AS staff_email FROM audit_log a
    LEFT JOIN staff s ON a.actor_type='staff' AND s.id=a.actor_id ORDER BY a.id DESC LIMIT 300`)).rows);
  app.get('/reconcile', { preHandler: auth('admin', 'finance') }, async (req) => { await log(req, 'reconcile_run'); return { mismatches: await reconcile(pool) }; });

  app.get('/staff', { preHandler: auth('admin') }, async () => (await pool.query('SELECT id, email, name, role, active, created_at FROM staff ORDER BY id')).rows);
  app.post('/staff', { preHandler: auth('admin') }, async (req) => {
    const b = parse(z.object({ email: z.string().max(200), name: z.string().min(2).max(100), role: z.enum(['admin', 'finance', 'risk', 'support', 'trader', 'viewer']),
      password: z.string().min(12, 'минимум 12 символов').max(200) }), req.body);
    const secret = base32Encode(crypto.randomBytes(20));
    const r = await pool.query(`INSERT INTO staff (email, name, password_hash, role, totp_secret_enc) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [b.email.trim().toLowerCase(), b.name, await hash(b.password, ARGON), b.role, pii.enc(secret)]);
    await log(req, 'staff_create', 'staff', r.rows[0].id, { email: b.email, role: b.role });
    return { id: r.rows[0].id, totpSecret: secret, otpauth: `otpauth://totp/NOIR:${encodeURIComponent(b.email)}?secret=${secret}&issuer=NOIR` };
  });
  app.post('/staff/:id/active', { preHandler: auth('admin') }, async (req) => {
    const b = parse(z.object({ active: z.boolean() }), req.body);
    const id = Number(req.params.id);
    if (id === req.staff.id) fail('VALIDATION', 'Нельзя отключить самого себя', 400);
    await pool.query('UPDATE staff SET active=$2 WHERE id=$1', [id, b.active]);
    if (!b.active) await sessions.revokeAllFor('staff', id);
    await log(req, 'staff_active', 'staff', id, b);
    return { ok: true };
  });
}
