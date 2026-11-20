// Usage: npm run create-staff -- admin@company.kz "Имя Фамилия" admin
// Prints a one-time password and the TOTP secret; add the secret to Google Authenticator / 1Password.
import crypto from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { loadConfig } from '../config.js';
import { createPool } from '../lib/db.js';
import { makePii, base32Encode } from '../lib/crypto.js';
import { migrate } from './migrate.js';

const [email, name, role = 'admin'] = process.argv.slice(2);
if (!email || !name) { console.error('Usage: npm run create-staff -- <email> "<name>" [admin|finance|risk|support|trader|viewer]'); process.exit(1); }
const cfg = loadConfig();
const pool = createPool(cfg);
await migrate(pool);
const pii = makePii(cfg.PII_KEY, cfg.LOOKUP_KEY);
const password = crypto.randomBytes(12).toString('base64url');
const secret = base32Encode(crypto.randomBytes(20));
await pool.query(`INSERT INTO staff (email, name, password_hash, role, totp_secret_enc) VALUES ($1,$2,$3,$4,$5)`,
  [email.toLowerCase(), name, await hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 }), role, pii.enc(secret)]);
await pool.query(`INSERT INTO audit_log (actor_type, action, details) VALUES ('system','staff_create_cli',$1)`, [{ email, role }]);
console.log(`\nStaff created: ${email} (${role})\nPassword:     ${password}\nTOTP secret:  ${secret}\notpauth://totp/NOIR:${encodeURIComponent(email)}?secret=${secret}&issuer=NOIR\n`);
await pool.end();
