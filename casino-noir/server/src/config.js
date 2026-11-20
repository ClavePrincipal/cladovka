import { z } from 'zod';

const hex32 = z.string().regex(/^[0-9a-f]{64}$/i, 'must be 64 hex chars (32 bytes). Generate: openssl rand -hex 32');
const list = z.string().optional().transform(v => (v ? v.split(',').map(s => s.trim()).filter(Boolean) : []));
const bool = d => z.enum(['true', 'false']).optional().transform(v => (v === undefined ? d : v === 'true'));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().default(8080),
  PUBLIC_URL: z.string().default('http://localhost:8080'),
  DATABASE_URL: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().default(20),
  // Secrets
  PII_KEY: hex32,               // AES-256-GCM key for personal data at rest
  LOOKUP_KEY: hex32,            // HMAC key for searchable hashes (email/phone)
  METRICS_TOKEN: z.string().min(24),
  PAYMENT_WEBHOOK_SECRET: z.string().min(24),
  KYC_WEBHOOK_SECRET: z.string().min(24),
  // Network
  TRUST_PROXY: bool(false),
  COOKIE_SECURE: bool(true),
  ADMIN_IP_ALLOWLIST: list,     // empty = allow all (use VPN/allowlist in production)
  BLOCKED_COUNTRIES: list,      // ISO-2 codes, read from CDN header (CF-IPCountry)
  COUNTRY_HEADER: z.string().default('cf-ipcountry'),
  // Business rules
  CURRENCY: z.enum(['KZT', 'RUB', 'USD', 'UZS']).default('KZT'), // one currency per deployment until FX is implemented
  SESSION_TTL_HOURS: z.coerce.number().int().default(12),
  STAFF_SESSION_TTL_HOURS: z.coerce.number().int().default(8),
  MIN_BET: z.coerce.number().int().default(100_00),            // minor units
  MAX_BET: z.coerce.number().int().default(5_000_000_00),
  MAX_PAYOUT: z.coerce.number().int().default(100_000_000_00),
  WELCOME_BONUS_PCT: z.coerce.number().default(100),
  WELCOME_BONUS_MAX: z.coerce.number().int().default(300_000_00),
  BONUS_WAGER: z.coerce.number().int().default(30),
  BONUS_DAYS: z.coerce.number().int().default(30),
  KYC_REQUIRED_FOR_WITHDRAWAL: bool(true),
  DEPOSIT_TURNOVER_BEFORE_WITHDRAWAL: z.coerce.number().default(1), // AML: wager deposits ×1 before withdrawal
  AML_LARGE_DEPOSIT: z.coerce.number().int().default(1_000_000_00),
  AML_LARGE_WITHDRAWAL: z.coerce.number().int().default(1_000_000_00),
  PAYMENT_PROVIDERS: list,      // enabled providers; 'sandbox' only in non-production
  KYC_PROVIDER: z.string().optional(),   // 'sandbox' in development; real provider adapter in production
  PENDING_DEPOSIT_TTL_MIN: z.coerce.number().int().default(60),
  // Withdrawals: small ones from clean, verified accounts are paid automatically; large ones need two approvers.
  AUTO_APPROVE_WITHDRAWAL: z.coerce.number().int().default(200_000_00),
  FOUR_EYES_WITHDRAWAL: z.coerce.number().int().default(2_000_000_00),
  NEW_ACCOUNT_HOLD_HOURS: z.coerce.number().int().default(24),
  SECURITY_HOLD_HOURS: z.coerce.number().int().default(24),
  LIVE_BET_DELAY_MS: z.coerce.number().int().default(5000),
  CASHBACK_PCT: z.coerce.number().default(10),
  CASHBACK_MIN: z.coerce.number().int().default(100_00),
  CASHBACK_MAX: z.coerce.number().int().default(1_000_000_00),
  LOGIN_FAILS_PER_IP: z.coerce.number().int().default(5),       // per account+IP in 15 min
  LOGIN_FAILS_PER_ACCOUNT: z.coerce.number().int().default(30), // per account from all IPs in 15 min (distributed attack)
  STAFF_IDLE_MIN: z.coerce.number().int().default(30),
  TURNSTILE_SITE_KEY: z.string().optional(),  // Cloudflare Turnstile CAPTCHA on registration/login (optional)
  TURNSTILE_SECRET: z.string().optional(),
  LICENSE_TEXT: z.string().optional(),        // shown in the footer only when a real licence exists
  LOG_LEVEL: z.string().default('info'),
});

export function loadConfig(env = process.env) {
  const r = schema.safeParse(env);
  if (!r.success) {
    const msg = r.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${msg}`);
  }
  const c = r.data;
  if (!c.PAYMENT_PROVIDERS.length) c.PAYMENT_PROVIDERS = c.NODE_ENV === 'production' ? [] : ['sandbox'];
  if (!c.KYC_PROVIDER && c.NODE_ENV !== 'production') c.KYC_PROVIDER = 'sandbox';
  if (!!c.TURNSTILE_SITE_KEY !== !!c.TURNSTILE_SECRET) throw new Error('Set both TURNSTILE_SITE_KEY and TURNSTILE_SECRET, or neither');
  if (c.NODE_ENV === 'production') {
    if (c.PAYMENT_PROVIDERS.includes('sandbox') || c.KYC_PROVIDER === 'sandbox') throw new Error('Sandbox payment/KYC providers must not be enabled in production');
    if (!c.COOKIE_SECURE) throw new Error('COOKIE_SECURE must be true in production');
    if (!c.PUBLIC_URL.startsWith('https://')) throw new Error('PUBLIC_URL must be https in production');
  }
  return Object.freeze(c);
}
