import { timingSafeEqualStr } from '../lib/crypto.js';
import { registry } from '../lib/metrics.js';
import { verifyHmacWebhook, signWebhook } from '../payments/providers.js';
import { fail } from '../lib/errors.js';
import { tx } from '../lib/db.js';
import { onIdentity, raise } from '../lib/aml.js';

const escHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export default async function systemRoutes(app) {
  const { cfg, pool, pii, sessions, audit, svc } = app.ctx;

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

  /**
   * KYC result. identityRef is the provider's stable identity of the person (document number + country, or the
   * provider's applicant fingerprint). One person = one account: duplicates go to manual review, and a person who
   * self-excluded on another account is blocked here too.
   */
  async function applyKyc(provider, ev) {
    if (!['verified', 'rejected', 'pending'].includes(ev.status) || !/^\d{9}$/.test(String(ev.playerId))) fail('VALIDATION', 'Bad KYC event', 400);
    return tx(pool, async c => {
      const u = (await c.query('SELECT id FROM users WHERE public_id=$1 FOR UPDATE', [String(ev.playerId)])).rows[0];
      if (!u) fail('NOT_FOUND', 'Unknown player', 404);
      let status = ev.status;
      const idHash = ev.identityRef ? pii.lookup('identity:' + ev.identityRef) : null;
      if (idHash) {
        await c.query('UPDATE users SET identity_hash=$2 WHERE id=$1', [u.id, idHash]);
        const others = (await c.query(`SELECT u.id, u.status, l.self_excluded_until FROM users u LEFT JOIN limits l ON l.user_id=u.id
          WHERE u.identity_hash=$1 AND u.id<>$2`, [idHash, u.id])).rows;
        if (others.some(o => o.self_excluded_until && o.self_excluded_until > new Date())) {
          status = 'rejected';
          await c.query(`UPDATE users SET status='blocked' WHERE id=$1`, [u.id]);
          await c.query(`UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [u.id]);
          await raise(c, u.id, 'self_excluded_duplicate', 'high', { otherUserIds: others.map(o => o.id) });
        } else if (others.length && status === 'verified') {
          status = 'pending'; // one person — one account: risk team decides
          await onIdentity(c, u.id, others.map(o => o.id));
        }
      }
      await c.query('UPDATE users SET kyc_status=$2 WHERE id=$1', [u.id, status]);
      await audit(c, { actorType: 'system', action: 'kyc_result', targetType: 'user', targetId: u.id, details: { provider, reported: ev.status, applied: status } });
      return { status };
    });
  }

  app.post('/api/webhooks/kyc/:provider', async (req) => {
    const ev = verifyHmacWebhook(req, cfg.KYC_WEBHOOK_SECRET);
    return { ok: true, ...(await applyKyc(req.params.provider, ev)) };
  });

  /* ---------- sandbox hosted checkout and KYC (development only) ---------- */
  if (!cfg.PAYMENT_PROVIDERS.includes('sandbox') && cfg.KYC_PROVIDER !== 'sandbox') return;

  const page = (title, body) => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>body{margin:0;background:#030304;color:#f2ede3;font:15px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px}
.card{max-width:420px;width:100%;background:#0b0b0e;border:1px solid #22222a;border-radius:16px;padding:28px;display:flex;flex-direction:column;gap:14px}
h1{margin:0;font:500 24px Georgia,serif}.sum{font:700 32px ui-monospace,monospace;color:#f0d79c}.m{color:#8e8a83;font-size:13px}
.row{display:flex;gap:10px}button{flex:1;height:48px;border-radius:8px;border:1px solid #22222a;font:700 14px system-ui;cursor:pointer;background:#121217;color:#f2ede3}
button.ok{background:#d6b46e;color:#140f05;border:0}label{font-size:12px;color:#8e8a83;display:flex;flex-direction:column;gap:6px}
input{height:44px;border-radius:8px;border:1px solid #22222a;background:#030304;color:#f2ede3;padding:0 12px;font:700 15px ui-monospace,monospace}.tag{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#d6b46e;font-weight:700}</style></head><body>${body}</body></html>`;

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
      <label>Последние 4 цифры тестовой карты / кошелька<input name="last4" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" value="4242" required></label>
      <input type="hidden" name="csrf" value="${escHtml(s.csrf_token)}">
      <div class="row"><button name="result" value="failed" type="submit" formnovalidate>Отклонить</button><button class="ok" name="result" value="succeeded" type="submit">Оплатить</button></div></form>`);
  });

  app.post('/pay/sandbox/:id', async (req, reply) => {
    const s = await sessions.load(req, 'player');
    if (!s || !timingSafeEqualStr(req.body?.csrf || '', s.csrf_token)) fail('CSRF', 'Сессия устарела', 403);
    const p = (await pool.query(`SELECT * FROM payments WHERE id=$1 AND user_id=$2 AND direction='deposit'`, [Number(req.params.id), s.user_id])).rows[0];
    if (!p) fail('NOT_FOUND', 'Платёж не найден', 404);
    const status = req.body.result === 'succeeded' ? 'succeeded' : 'failed';
    // Simulate the PSP calling our webhook: same signature check and code path as production.
    const last4 = /^\d{4}$/.test(req.body.last4 || '') ? req.body.last4 : '4242';
    const { raw, headers } = signWebhook({ paymentId: p.id, providerRef: p.provider_ref, status, amount: p.amount, currency: p.currency,
      instrument: `${p.method}:••${last4}` }, cfg.PAYMENT_WEBHOOK_SECRET);
    await svc.payments.webhook('sandbox', { headers, rawBody: raw });
    return reply.redirect(`/#deposit-${status}`);
  });

  app.get('/kyc/sandbox', async (req, reply) => {
    const s = await sessions.load(req, 'player');
    reply.type('text/html');
    if (!s) return page('Войдите', `<div class="card"><h1>Войдите в аккаунт</h1><a href="/" style="color:#d6b46e">Вернуться на сайт</a></div>`);
    return page('Верификация · Sandbox', `<form class="card" method="post" action="/kyc/sandbox">
      <span class="tag">Тестовая верификация</span><h1>Подтверждение личности</h1>
      <p class="m">В рабочей версии здесь откроется проверка провайдера (Sumsub, Veriff): фото документа и селфи. В песочнице введите номер документа: один номер можно использовать только на одном аккаунте.</p>
      <label>Номер удостоверения личности<input name="doc" pattern="[0-9A-Za-z]{6,12}" maxlength="12" required></label>
      <input type="hidden" name="csrf" value="${escHtml(s.csrf_token)}">
      <div class="row"><button name="result" value="rejected" type="submit" formnovalidate>Отклонить</button><button class="ok" name="result" value="verified" type="submit">Подтвердить</button></div></form>`);
  });

  app.post('/kyc/sandbox', async (req, reply) => {
    const s = await sessions.load(req, 'player');
    if (!s || !timingSafeEqualStr(req.body?.csrf || '', s.csrf_token)) fail('CSRF', 'Сессия устарела', 403);
    const u = (await pool.query('SELECT public_id FROM users WHERE id=$1', [s.user_id])).rows[0];
    const doc = String(req.body.doc || '').toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 12);
    const r = await applyKyc('sandbox', { playerId: u.public_id, status: req.body.result === 'verified' ? 'verified' : 'rejected', identityRef: doc ? 'KZ:' + doc : null });
    return reply.redirect(`/#kyc-${r.status}`);
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
