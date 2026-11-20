// Opaque server-side sessions. Cookie holds a random token; DB stores only its SHA-256.
// CSRF: SameSite=Strict cookie + per-session token required in the X-CSRF-Token header for every mutating request.
import { randomToken, sha256, timingSafeEqualStr } from './crypto.js';
import { fail } from './errors.js';

export function makeSessions({ pool, cfg }) {
  const name = kind => (cfg.COOKIE_SECURE ? '__Host-' : '') + (kind === 'staff' ? 'noir_staff' : 'noir_sid');
  const cookieOpts = ttlH => ({ httpOnly: true, secure: cfg.COOKIE_SECURE, sameSite: 'strict', path: '/', maxAge: ttlH * 3600 });

  async function create(reply, req, { userId = null, staffId = null }) {
    const kind = staffId ? 'staff' : 'player';
    const ttl = kind === 'staff' ? cfg.STAFF_SESSION_TTL_HOURS : cfg.SESSION_TTL_HOURS;
    const token = randomToken(32), csrf = randomToken(24);
    await pool.query(`INSERT INTO sessions (token_hash, csrf_token, user_id, staff_id, ip, user_agent, expires_at)
      VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(hours => $7))`,
      [sha256(token), csrf, userId, staffId, req.ip, String(req.headers['user-agent'] || '').slice(0, 300), ttl]);
    reply.setCookie(name(kind), token, cookieOpts(ttl));
    return csrf;
  }

  async function load(req, kind) {
    const token = req.cookies?.[name(kind)];
    if (!token || token.length > 100) return null;
    const r = await pool.query(`UPDATE sessions SET last_seen = now() WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
      RETURNING id, csrf_token, user_id, staff_id`, [sha256(token)]);
    const s = r.rows[0];
    if (!s || (kind === 'staff') !== !!s.staff_id) return null;
    return s;
  }

  async function revoke(req, reply, kind) {
    const token = req.cookies?.[name(kind)];
    if (token) await pool.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1', [sha256(token)]);
    reply.clearCookie(name(kind), { path: '/' });
  }

  const revokeAllFor = (col, id) => pool.query(`UPDATE sessions SET revoked_at = now() WHERE ${col === 'staff' ? 'staff_id' : 'user_id'} = $1 AND revoked_at IS NULL`, [id]);

  function checkCsrf(req, session) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    if (!timingSafeEqualStr(req.headers['x-csrf-token'] || '', session.csrf_token)) fail('CSRF', 'Сессия устарела. Обновите страницу.', 403);
  }

  return { create, load, revoke, revokeAllFor, checkCsrf };
}
