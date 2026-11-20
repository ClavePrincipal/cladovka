-- Anti-fraud, account security and responsible-gaming hardening.

-- Player security & risk controls
ALTER TABLE users
  ADD COLUMN totp_secret_enc     BYTEA,
  ADD COLUMN totp_enabled        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN security_hold_until TIMESTAMPTZ,               -- withdrawals blocked (after password / 2FA change)
  ADD COLUMN stake_factor        NUMERIC(4,2) NOT NULL DEFAULT 1 CHECK (stake_factor >= 0 AND stake_factor <= 10),
  ADD COLUMN identity_hash       BYTEA;                     -- HMAC of the KYC document identity, for duplicate detection
CREATE INDEX users_identity_idx ON users (identity_hash) WHERE identity_hash IS NOT NULL;

-- Failed logins per (account, IP): one attacker cannot lock a victim out from the victim's own network.
CREATE TABLE login_failures (
  user_id BIGINT NOT NULL REFERENCES users(id),
  ip      INET,
  at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX login_failures_idx ON login_failures (user_id, at);

-- Payments: the instrument (masked card / wallet / crypto address fingerprint from the PSP) enables closed-loop payouts.
ALTER TABLE payments
  ADD COLUMN instrument TEXT,
  ADD COLUMN approvals  BIGINT[] NOT NULL DEFAULT '{}';
ALTER TABLE payments DROP CONSTRAINT payments_status_check;
ALTER TABLE payments ADD CONSTRAINT payments_status_check
  CHECK (status IN ('created','pending','succeeded','failed','expired','review','approved','rejected','paid','chargeback'));
ALTER TABLE payments DROP CONSTRAINT payments_idempotency_key_key;
CREATE UNIQUE INDEX payments_user_idem ON payments (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX payments_instrument_idx ON payments (instrument) WHERE instrument IS NOT NULL;

ALTER TABLE ledger DROP CONSTRAINT ledger_type_check;
ALTER TABLE ledger ADD CONSTRAINT ledger_type_check CHECK (type IN ('deposit','withdrawal_hold','withdrawal_release','withdrawal_paid',
  'bet','win','refund','bonus_grant','bonus_release','bonus_expire','bonus_forfeit','cashback','adjustment','chargeback'));

-- Bonus is tied to a product (casino or sport wagering rules) and to the deposit instrument (one bonus per card).
ALTER TABLE bonuses
  ADD COLUMN product    TEXT NOT NULL DEFAULT 'casino' CHECK (product IN ('casino','sport')),
  ADD COLUMN instrument TEXT;
