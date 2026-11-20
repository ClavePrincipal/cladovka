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
export async function deposit(c, amount, withBonus = false) {
  const d = await c.post('/api/wallet/deposit', { provider: 'sandbox', method: 'card', amount, withBonus });
  if (d.status !== 200) throw new Error(JSON.stringify(d.body));
  const me = await c.get('/api/me');
  const r = await c.req('POST', `/pay/sandbox/${d.body.paymentId}`, `csrf=${encodeURIComponent(me.body.csrf)}&result=succeeded`, { 'content-type': 'application/x-www-form-urlencoded' });
  if (r.status !== 302) throw new Error('checkout failed ' + r.status);
  return d.body.paymentId;
}

export function sign(body, secret = cfg.PAYMENT_WEBHOOK_SECRET) {
  const raw = JSON.stringify(body), ts = Math.floor(Date.now() / 1000);
  return { raw, headers: { 'content-type': 'application/json', 'x-timestamp': String(ts), 'x-signature': crypto.createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex') } };
}
