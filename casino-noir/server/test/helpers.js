import crypto from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/lib/db.js';
import { buildApp } from '../src/app.js';
import { migrate } from '../src/scripts/migrate.js';

export const cfg = loadConfig({
  NODE_ENV: 'test', COOKIE_SECURE: 'false',
  DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgres://noir:noir_dev_pw@localhost:5432/noir_test',
  PII_KEY: 'a'.repeat(64), LOOKUP_KEY: 'b'.repeat(64), METRICS_TOKEN: 'm'.repeat(32),
  PAYMENT_WEBHOOK_SECRET: 'w'.repeat(32), KYC_WEBHOOK_SECRET: 'k'.repeat(32), LOG_LEVEL: 'warn',
  LIVE_BET_DELAY_MS: '300', AUTO_APPROVE_WITHDRAWAL: '300000', FOUR_EYES_WITHDRAWAL: '500000',
});

export async function setup() {
  const pool = createPool(cfg);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(pool);
  const app = await buildApp({ cfg, pool, logger: false });
  await app.ready();
  return { app, pool };
}

/** Minimal cookie-jar client around app.inject. */
export function client(app) {
  const jar = {}; let csrf = null;
  const ip = `10.${crypto.randomInt(255)}.${crypto.randomInt(255)}.${crypto.randomInt(1, 255)}`;
  const req = async (method, url, body, extra = {}) => {
    const r = await app.inject({ method, url, payload: body, remoteAddress: ip,
      headers: { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '), 'x-requested-with': 'noir', ...(csrf ? { 'x-csrf-token': csrf } : {}), ...extra } });
    for (const c of r.cookies) { if (c.value) jar[c.name] = c.value; else delete jar[c.name]; }
    const json = r.headers['content-type']?.includes('json') ? r.json() : null;
    if (json?.csrf) csrf = json.csrf;
    return { status: r.statusCode, body: json, raw: r };
  };
  return { req, get: u => req('GET', u), post: (u, b = {}, h) => req('POST', u, b, h), patch: (u, b) => req('PATCH', u, b), setCsrf: v => { csrf = v; } };
}

export const register = async (c, extra = {}) =>
  c.post('/api/auth/register', { method: 'oneclick', birthDate: '1990-01-01', acceptTerms: true, ...extra });

/** Deposit through the sandbox checkout (same signed-webhook path as production). */
export async function deposit(c, amount, withBonus = false, last4 = String(crypto.randomInt(1000, 9999))) {
  const d = await c.post('/api/wallet/deposit', { provider: 'sandbox', method: 'card', amount, withBonus });
  if (d.status !== 200) throw new Error(JSON.stringify(d.body));
  const me = await c.get('/api/me');
  const r = await c.req('POST', `/pay/sandbox/${d.body.paymentId}`, `csrf=${encodeURIComponent(me.body.csrf)}&result=succeeded&last4=${last4}`, { 'content-type': 'application/x-www-form-urlencoded' });
  if (r.status !== 302) throw new Error('checkout failed ' + r.status);
  return d.body.paymentId;
}

export function sign(body, secret = cfg.PAYMENT_WEBHOOK_SECRET) {
  const raw = JSON.stringify(body), ts = Math.floor(Date.now() / 1000);
  return { raw, headers: { 'content-type': 'application/json', 'x-timestamp': String(ts), 'x-signature': crypto.createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex') } };
}

/** Instrument string the sandbox PSP reports for a card ending in last4. */
export const card = last4 => `card:••${last4}`;

/** KYC result through the signed provider webhook. */
export async function kyc(app, publicId, status, identityRef) {
  const ev = sign({ playerId: publicId, status, identityRef }, cfg.KYC_WEBHOOK_SECRET);
  return app.inject({ method: 'POST', url: '/api/webhooks/kyc/sandbox', payload: ev.raw, headers: ev.headers });
}

/** Creates a staff member and returns a logged-in client. */
export async function staffClient(app, pool, email, role) {
  const { hash } = await import('@node-rs/argon2');
  const { makePii, totpCode } = await import('../src/lib/crypto.js');
  const secret = 'JBSWY3DPEHPK3PXP';
  await pool.query(`INSERT INTO staff (email, name, password_hash, role, totp_secret_enc) VALUES ($1,$2,$3,$4,$5)`,
    [email, role, await hash('staff-password-123'), role, makePii(cfg.PII_KEY, cfg.LOOKUP_KEY).enc(secret)]);
  const s = client(app);
  const r = await s.post('/api/admin/login', { email, password: 'staff-password-123', totp: totpCode(secret) });
  if (r.status !== 200) throw new Error('staff login failed');
  return s;
}
