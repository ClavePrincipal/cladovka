// Payment provider adapters. Each real PSP (bank acquiring, Kaspi, P2P aggregator, crypto processing)
// implements the same interface, so the rest of the platform never changes when a partner is added.
//
// interface Provider {
//   id: string
//   methods: { id, name, group, min, max, eta }[]            // amounts in minor units
//   createDeposit(payment)  -> { redirectUrl }                 // hosted checkout URL
//   createPayout(payment)   -> { providerRef }                 // async: final status arrives by webhook
//   verifyWebhook(req)      -> { providerRef, paymentId, status: 'succeeded'|'failed'|'paid', amount }
// }
import crypto from 'node:crypto';
import { timingSafeEqualStr } from '../lib/crypto.js';
import { fail } from '../lib/errors.js';

/** Standard HMAC-SHA256 webhook check with a 5-minute replay window. Most PSPs use this scheme. */
export function verifyHmacWebhook(req, secret) {
  const ts = Number(req.headers['x-timestamp']), sig = String(req.headers['x-signature'] || '');
  if (!ts || Math.abs(Date.now() / 1000 - ts) > 300) fail('WEBHOOK_STALE', 'Webhook timestamp outside window', 401);
  const expected = crypto.createHmac('sha256', secret).update(`${ts}.${req.rawBody ?? ''}`).digest('hex');
  if (!timingSafeEqualStr(sig, expected)) fail('WEBHOOK_SIGNATURE', 'Bad webhook signature', 401);
  return JSON.parse(req.rawBody);
}
export function signWebhook(body, secret, ts = Math.floor(Date.now() / 1000)) {
  const raw = JSON.stringify(body);
  return { raw, headers: { 'x-timestamp': String(ts), 'x-signature': crypto.createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex') } };
}

const K = 100; // ₸ → tiyn
const SANDBOX_METHODS = [
  { id: 'card', group: 'Банковские карты', name: 'Visa / Mastercard', min: 2000 * K, max: 1_500_000 * K, eta: 'Мгновенно' },
  { id: 'kaspi', group: 'Банковские карты', name: 'Kaspi.kz', min: 1000 * K, max: 2_000_000 * K, eta: 'Мгновенно' },
  { id: 'halyk', group: 'Банковские карты', name: 'Halyk Bank', min: 1000 * K, max: 1_500_000 * K, eta: 'Мгновенно' },
  { id: 'apple', group: 'Кошельки', name: 'Apple Pay', min: 2000 * K, max: 1_000_000 * K, eta: 'Мгновенно' },
  { id: 'gpay', group: 'Кошельки', name: 'Google Pay', min: 2000 * K, max: 1_000_000 * K, eta: 'Мгновенно' },
  { id: 'usdt', group: 'Криптовалюта', name: 'USDT TRC-20', min: 5000 * K, max: 50_000_000 * K, eta: '1 подтверждение' },
  { id: 'btc', group: 'Криптовалюта', name: 'Bitcoin', min: 10000 * K, max: 50_000_000 * K, eta: '2 подтверждения' },
];

/** Sandbox PSP: hosted checkout page on our own server, signed webhooks — same flow as a real provider. */
function sandbox(cfg) {
  return {
    id: 'sandbox',
    methods: SANDBOX_METHODS,
    async createDeposit(p) { return { redirectUrl: `/pay/sandbox/${p.id}`, providerRef: `sbx_${p.id}_${crypto.randomBytes(6).toString('hex')}` }; },
    async createPayout(p) { return { providerRef: `sbx_out_${p.id}_${crypto.randomBytes(6).toString('hex')}` }; },
    verifyWebhook(req) { return verifyHmacWebhook(req, cfg.PAYMENT_WEBHOOK_SECRET); },
  };
}

export function makeProviders(cfg) {
  const all = { sandbox };
  const enabled = {};
  for (const id of cfg.PAYMENT_PROVIDERS) {
    if (!all[id]) throw new Error(`Unknown payment provider "${id}". Add an adapter in src/payments/providers.js`);
    enabled[id] = all[id](cfg);
  }
  return {
    get: id => enabled[id] || fail('PROVIDER', 'Платёжный способ недоступен', 400),
    methods: () => Object.values(enabled).flatMap(p => p.methods.map(m => ({ ...m, provider: p.id }))),
    find(provider, method) { const p = this.get(provider); const m = p.methods.find(x => x.id === method); if (!m) fail('PROVIDER', 'Способ оплаты недоступен', 400); return { p, m }; },
  };
}
