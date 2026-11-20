import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import cookie from '@fastify/cookie';
import fstatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makePii } from './lib/crypto.js';
import { makeSessions } from './lib/session.js';
import { makeCasino } from './games/service.js';
import { makeSport } from './lib/sport.js';
import { makeProviders } from './payments/providers.js';
import { makePayments } from './payments/service.js';
import { AppError, fail } from './lib/errors.js';
import { metrics } from './lib/metrics.js';
import playerRoutes from './routes/player.js';
import adminRoutes from './routes/admin.js';
import systemRoutes from './routes/system.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export async function buildApp({ cfg, pool, logger = true }) {
  const app = Fastify({
    trustProxy: cfg.TRUST_PROXY,
    bodyLimit: 64 * 1024,
    logger: logger && {
      level: cfg.LOG_LEVEL,
      redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]', 'res.headers["set-cookie"]'],
      // Query strings can carry personal data (back-office search by e-mail/phone): log the path only.
      serializers: { req: r => ({ method: r.method, url: String(r.url).split('?')[0], ip: r.ip }) },
    },
  });

  // Keep the raw body for webhook signature verification.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = body;
    try { done(null, body ? JSON.parse(body) : {}); } catch { const e = new Error('Invalid JSON'); e.statusCode = 400; done(e); }
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'", ...(cfg.TURNSTILE_SITE_KEY ? ['https://challenges.cloudflare.com'] : [])],
        frameSrc: cfg.TURNSTILE_SITE_KEY ? ['https://challenges.cloudflare.com'] : ["'none'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"],
        formAction: ["'self'"], frameAncestors: ["'none'"], baseUri: ["'none'"], objectSrc: ["'none'"],
        ...(cfg.COOKIE_SECURE ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    hsts: cfg.COOKIE_SECURE ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
    crossOriginEmbedderPolicy: false,
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute',
    errorResponseBuilder: (_req, ctx) => ({ statusCode: 429, error: 'RATE_LIMIT', message: `Слишком много запросов. Повторите через ${Math.ceil(ctx.ttl / 1000)} с.` }) });
  await app.register(cookie);

  const pii = makePii(cfg.PII_KEY, cfg.LOOKUP_KEY);
  const sessions = makeSessions({ pool, cfg });
  const audit = (c, a) => (c || pool).query(
    `INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, ip, details) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [a.actorType, a.actorId ?? null, a.action, a.targetType ?? null, a.targetId ?? null, a.ip ?? null, a.details ?? {}]);
  const providers = makeProviders(cfg);
  const svc = {
    casino: makeCasino({ pool, cfg }),
    sport: makeSport({ pool, cfg }),
    payments: makePayments({ pool, cfg, providers, audit }),
  };
  app.decorate('ctx', { cfg, pool, pii, sessions, audit, svc });

  // Geo-blocking (country comes from the CDN/WAF in front of the app).
  app.addHook('onRequest', async (req) => {
    if (!cfg.BLOCKED_COUNTRIES.length || !req.url.startsWith('/api/') || req.url.startsWith('/api/webhooks/')) return;
    const cc = String(req.headers[cfg.COUNTRY_HEADER] || '').toUpperCase();
    if (cc && cfg.BLOCKED_COUNTRIES.includes(cc)) fail('GEO_BLOCKED', 'Сервис недоступен в вашей стране', 451);
  });

  app.addHook('onRequest', async (req) => {
    if ((req.url === '/admin' || req.url.startsWith('/admin/') || req.url.startsWith('/api/admin/')) && cfg.ADMIN_IP_ALLOWLIST.length && !cfg.ADMIN_IP_ALLOWLIST.includes(req.ip))
      fail('FORBIDDEN', 'Forbidden', 403);
  });

  app.addHook('onResponse', async (req, reply) => {
    metrics.http.observe({ method: req.method, route: req.routeOptions?.url || 'unknown', status: reply.statusCode }, reply.elapsedTime / 1000);
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: err.code, message: err.message, ...(err.extra || {}) });
    if (err.statusCode === 429) return reply.code(429).send(err);
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: 'BAD_REQUEST', message: 'Некорректный запрос' });
    if (err.code === '23514') return reply.code(409).send({ error: 'CONSTRAINT', message: 'Операция отклонена' });
    metrics.errors.inc();
    req.log.error(err);
    return reply.code(500).send({ error: 'INTERNAL', message: 'Внутренняя ошибка. Мы уже разбираемся.' });
  });

  await app.register(systemRoutes);
  await app.register(playerRoutes, { prefix: '/api' });
  await app.register(adminRoutes, { prefix: '/api/admin' });

  await app.register(fstatic, { root: path.join(root, 'web'), prefix: '/', index: 'index.html' });
  await app.register(fstatic, { root: path.join(root, 'admin'), prefix: '/admin/', decorateReply: false, index: 'index.html' });
  return app;
}
