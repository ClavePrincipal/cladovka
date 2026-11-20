import { timingSafeEqualStr } from '../lib/crypto.js';
import { registry } from '../lib/metrics.js';
import { verifyHmacWebhook, signWebhook } from '../payments/providers.js';
import { fail } from '../lib/errors.js';

const escHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export default async function systemRoutes(app) {
  const { cfg, pool, sessions, audit, svc } = app.ctx;

  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) =>
    done(null, Object.fromEntries(new URLSearchParams(body))));

  app.get('/health', { config: { rateLimit: false } }, async () => ({ ok: true }));
  app.get('/ready', { config: { rateLimit: false } }, async (req, reply) => {
    try { await pool.query('SELECT 1'); return { ok: true }; } catch { return reply.code(503).send({ ok: false }); }
  });

  // Prometheus scrape endpoint, bearer-token protected.
  app.get('/metrics', { config: { rateLimit: false } }, async (req, reply) => {
    if (!timingSafeEqualStr(req.headers.authorization || '', `Bearer ${cfg.METRICS_TOKEN}`)) return reply.code(401).send('unauthorized');
    reply.type(registry.contentType);
    return registry.metrics();
  });

  /* ---------- provider webhooks (signature-verified, idempotent) ---------- */
  app.post('/api/webhooks/payments/:provider', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req) => {
    const r = await svc.payments.webhook(req.params.provider, req);
    return { ok: true, ...r };
  });

  app.post('/api/webhooks/kyc/:provider', async (req) => {
    const ev = verifyHmacWebhook(req, cfg.KYC_WEBHOOK_SECRET);
    if (!['verified', 'rejected', 'pending'].includes(ev.status) || !/^\d{9}$/.test(String(ev.playerId))) fail('VALIDATION', 'Bad KYC event', 400);
    const r = await pool.query('UPDATE users SET kyc_status=$2 WHERE public_id=$1 RETURNING id', [String(ev.playerId), ev.status]);
    if (r.rowCount) await audit(null, { actorType: 'system', action: 'kyc_webhook', targetType: 'user', targetId: r.rows[0].id, details: { provider: req.params.provider, status: ev.status } });
    return { ok: true };
  });

  /* ---------- sandbox hosted checkout (development only) ---------- */
  if (!cfg.PAYMENT_PROVIDERS.includes('sandbox')) return;

  const page = (title, body) => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>body{margin:0;background:#030304;color:#f2ede3;font:15px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px}
.card{max-width:420px;width:100%;background:#0b0b0e;border:1px solid #22222a;border-radius:16px;padding:28px;display:flex;flex-direction:column;gap:14px}
h1{margin:0;font:500 24px Georgia,serif}.sum{font:700 32px ui-monospace,monospace;color:#f0d79c}.m{color:#8e8a83;font-size:13px}
.row{display:flex;gap:10px}button{flex:1;height:48px;border-radius:8px;border:1px solid #22222a;font:700 14px system-ui;cursor:pointer;background:#121217;color:#f2ede3}
button.ok{background:#d6b46e;color:#140f05;border:0}.tag{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#d6b46e;font-weight:700}</style></head><body>${body}</body></html>`;

  app.get('/pay/sandbox/:id', async (req, reply) => {
    const s = await sessions.load(req, 'player');
    const p = s && (await pool.query(`SELECT * FROM payments WHERE id=$1 AND user_id=$2 AND direction='deposit'`, [Number(req.params.id), s.user_id])).rows[0];
    reply.type('text/html');
    if (!p) return page('Платёж не найден', `<div class="card"><h1>Платёж не найден</h1><a href="/" style="color:#d6b46e">Вернуться на сайт</a></div>`);
    if (p.status !== 'pending') return page('Платёж обработан', `<div class="card"><h1>Платёж уже обработан</h1><p class="m">Статус: ${escHtml(p.status)}</p><a href="/#wallet" style="color:#d6b46e">Вернуться на сайт</a></div>`);
    return page('Оплата · Sandbox', `<form class="card" method="post" action="/pay/sandbox/${p.id}">
      <span class="tag">Тестовый платёжный шлюз</span><h1>Оплата заказа №${p.id}</h1>
      <div class="sum">${(p.amount / 100).toLocaleString('ru-RU')} ${escHtml(p.currency)}</div>
      <p class="m">Способ: ${escHtml(p.method)}. Это песочница: деньги не списываются. В рабочей версии здесь будет страница банка или платёжного провайдера.</p>
      <input type="hidden" name="csrf" value="${escHtml(s.csrf_token)}">
      <div class="row"><button name="result" value="failed" type="submit">Отклонить</button><button class="ok" name="result" value="succeeded" type="submit">Оплатить</button></div></form>`);
  });

  app.post('/pay/sandbox/:id', async (req, reply) => {
    const s = await sessions.load(req, 'player');
    if (!s || !timingSafeEqualStr(req.body?.csrf || '', s.csrf_token)) fail('CSRF', 'Сессия устарела', 403);
    const p = (await pool.query(`SELECT * FROM payments WHERE id=$1 AND user_id=$2 AND direction='deposit'`, [Number(req.params.id), s.user_id])).rows[0];
    if (!p) fail('NOT_FOUND', 'Платёж не найден', 404);
    const status = req.body.result === 'succeeded' ? 'succeeded' : 'failed';
    // Simulate the PSP calling our webhook: same signature check and code path as production.
    const { raw, headers } = signWebhook({ paymentId: p.id, providerRef: p.provider_ref, status, amount: p.amount }, cfg.PAYMENT_WEBHOOK_SECRET);
    await svc.payments.webhook('sandbox', { headers, rawBody: raw });
    return reply.redirect(`/#deposit-${status}`);
  });

  // Sandbox payouts: finance approves in the back office, the "bank" confirms a few seconds later.
  setInterval(async () => {
    try {
      const rows = (await pool.query(`SELECT id, provider_ref, amount FROM payments WHERE provider='sandbox' AND direction='withdrawal' AND status='approved' LIMIT 50`)).rows;
      for (const p of rows) {
        const { raw, headers } = signWebhook({ paymentId: p.id, providerRef: p.provider_ref, status: 'paid', amount: p.amount }, cfg.PAYMENT_WEBHOOK_SECRET);
        await svc.payments.webhook('sandbox', { headers, rawBody: raw });
      }
    } catch (e) { app.log.error(e, 'sandbox payout job'); }
  }, 5000).unref();
}
