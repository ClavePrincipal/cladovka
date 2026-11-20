-- NOIR platform schema. All money is BIGINT in minor units (1 ₸ = 100 tiyn).
-- Ledger and audit tables are append-only (enforced by triggers below).

CREATE TABLE users (
  id              BIGSERIAL PRIMARY KEY,
  public_id       TEXT NOT NULL UNIQUE,                 -- 9-digit player ID shown in UI
  email_hash      BYTEA UNIQUE,                         -- HMAC-SHA256(lowercased email), for lookup
  email_enc       BYTEA,                                -- AES-256-GCM ciphertext
  phone_hash      BYTEA UNIQUE,
  phone_enc       BYTEA,
  password_hash   TEXT NOT NULL,                        -- argon2id
  birth_date_enc  BYTEA,
  currency        CHAR(3) NOT NULL DEFAULT 'KZT',
  country         CHAR(2),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked','closed')),
  kyc_status      TEXT NOT NULL DEFAULT 'none' CHECK (kyc_status IN ('none','pending','verified','rejected')),
  bonus_pref      TEXT NOT NULL DEFAULT 'casino' CHECK (bonus_pref IN ('casino','sport','none')),
  failed_logins   INT NOT NULL DEFAULT 0,
  locked_until    TIMESTAMPTZ,
  reg_ip          INET,
  last_ip         INET,
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id),
  kind       TEXT NOT NULL CHECK (kind IN ('cash','bonus','withdraw_hold')),
  currency   CHAR(3) NOT NULL,
  balance    BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
  UNIQUE (user_id, kind)
);

-- Single-entry ledger with running balance; every balance change has exactly one row here.
CREATE TABLE ledger (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(id),
  account_kind    TEXT NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('deposit','withdrawal_hold','withdrawal_release','withdrawal_paid',
                    'bet','win','refund','bonus_grant','bonus_release','bonus_expire','cashback','adjustment')),
  amount          BIGINT NOT NULL,                     -- signed
  balance_after   BIGINT NOT NULL,
  ref_type        TEXT,
  ref_id          BIGINT,
  idempotency_key TEXT UNIQUE,
  meta            JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ledger_user_idx ON ledger (user_id, id DESC);
CREATE INDEX ledger_type_time_idx ON ledger (type, created_at);

CREATE TABLE staff (
  id              BIGSERIAL PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('admin','finance','risk','support','trader','viewer')),
  totp_secret_enc BYTEA NOT NULL,
  active          BOOLEAN NOT NULL DEFAULT true,
  failed_logins   INT NOT NULL DEFAULT 0,
  locked_until    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id          BIGSERIAL PRIMARY KEY,
  token_hash  BYTEA NOT NULL UNIQUE,                    -- SHA-256 of the cookie token; raw token never stored
  csrf_token  TEXT NOT NULL,
  user_id     BIGINT REFERENCES users(id),
  staff_id    BIGINT REFERENCES staff(id),
  ip          INET,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  CHECK ((user_id IS NULL) <> (staff_id IS NULL))
);

CREATE TABLE limits (
  user_id               BIGINT PRIMARY KEY REFERENCES users(id),
  deposit_daily         BIGINT,
  deposit_weekly        BIGINT,
  deposit_monthly       BIGINT,
  loss_daily            BIGINT,
  reality_check_min     INT,
  self_excluded_until   TIMESTAMPTZ,
  pending               JSONB,                         -- limit increases wait 24h (cooling-off)
  pending_effective_at  TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE fair_seeds (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id),
  server_seed  TEXT NOT NULL,
  server_hash  TEXT NOT NULL,
  client_seed  TEXT NOT NULL,
  nonce        BIGINT NOT NULL DEFAULT 0,
  active       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  revealed_at  TIMESTAMPTZ
);
CREATE UNIQUE INDEX fair_one_active ON fair_seeds (user_id) WHERE active;

CREATE TABLE game_rounds (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id),
  game        TEXT NOT NULL,
  bet         BIGINT NOT NULL,
  payout      BIGINT NOT NULL DEFAULT 0,
  status      TEXT NOT NULL CHECK (status IN ('open','settled')),
  seed_id     BIGINT NOT NULL REFERENCES fair_seeds(id),
  nonce       BIGINT NOT NULL,
  state       JSONB NOT NULL DEFAULT '{}',              -- server-only (mine positions, crash point)
  result      JSONB NOT NULL DEFAULT '{}',              -- shown to player
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at  TIMESTAMPTZ
);
CREATE INDEX rounds_user_idx ON game_rounds (user_id, id DESC);
CREATE INDEX rounds_game_time_idx ON game_rounds (game, created_at);
CREATE UNIQUE INDEX rounds_one_open ON game_rounds (user_id, game) WHERE status = 'open';

CREATE TABLE sport_events (
  id          BIGSERIAL PRIMARY KEY,
  sport       TEXT NOT NULL,
  league      TEXT NOT NULL,
  home        TEXT NOT NULL,
  away        TEXT NOT NULL,
  starts_at   TIMESTAMPTZ NOT NULL,
  status      TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','live','suspended','finished','cancelled')),
  live_clock  TEXT,
  score       INT[] NOT NULL DEFAULT '{0,0}',
  probs       NUMERIC(6,5)[] NOT NULL,                  -- true probabilities for 1 / X / 2 (X = 0 when no draw)
  margin      NUMERIC(5,4) NOT NULL,
  odds        NUMERIC(8,2)[] NOT NULL,                  -- derived: floor(1/(p*(1+margin)), 2)
  result      SMALLINT CHECK (result IN (0,1,2)),
  feed_ref    TEXT UNIQUE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sport_bets (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id),
  kind        TEXT NOT NULL CHECK (kind IN ('single','express')),
  stake       BIGINT NOT NULL,
  odds        NUMERIC(12,2) NOT NULL,
  boost       NUMERIC(4,2) NOT NULL DEFAULT 1,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','won','lost','void')),
  payout      BIGINT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at  TIMESTAMPTZ
);
CREATE INDEX sport_bets_user_idx ON sport_bets (user_id, id DESC);

CREATE TABLE sport_selections (
  bet_id    BIGINT NOT NULL REFERENCES sport_bets(id),
  event_id  BIGINT NOT NULL REFERENCES sport_events(id),
  outcome   SMALLINT NOT NULL CHECK (outcome IN (0,1,2)),
  odds      NUMERIC(8,2) NOT NULL,
  result    TEXT CHECK (result IN ('won','lost','void')),
  PRIMARY KEY (bet_id, event_id)
);
CREATE INDEX sel_event_idx ON sport_selections (event_id);

CREATE TABLE payments (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(id),
  direction       TEXT NOT NULL CHECK (direction IN ('deposit','withdrawal')),
  provider        TEXT NOT NULL,
  method          TEXT NOT NULL,
  amount          BIGINT NOT NULL CHECK (amount > 0),
  currency        CHAR(3) NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('created','pending','succeeded','failed','review','approved','rejected','paid')),
  provider_ref    TEXT,
  idempotency_key TEXT UNIQUE,
  with_bonus      BOOLEAN NOT NULL DEFAULT false,
  reviewed_by     BIGINT REFERENCES staff(id),
  review_note     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_ref)
);
CREATE INDEX payments_user_idx ON payments (user_id, id DESC);
CREATE INDEX payments_status_idx ON payments (direction, status);

CREATE TABLE bonuses (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id),
  amount       BIGINT NOT NULL,
  wager_req    BIGINT NOT NULL,
  wagered      BIGINT NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','released','expired','forfeited')),
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX bonus_one_active ON bonuses (user_id) WHERE status = 'active';

CREATE TABLE aml_alerts (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id),
  rule        TEXT NOT NULL,
  severity    TEXT NOT NULL CHECK (severity IN ('low','medium','high')),
  details     JSONB NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  closed_by   BIGINT REFERENCES staff(id),
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at   TIMESTAMPTZ
);
CREATE INDEX aml_open_idx ON aml_alerts (status, created_at DESC);

CREATE TABLE audit_log (
  id          BIGSERIAL PRIMARY KEY,
  actor_type  TEXT NOT NULL CHECK (actor_type IN ('staff','user','system')),
  actor_id    BIGINT,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   BIGINT,
  ip          INET,
  details     JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_time_idx ON audit_log (created_at DESC);
CREATE INDEX audit_target_idx ON audit_log (target_type, target_id);

-- Append-only enforcement for money and audit trails.
CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME; END $$;
CREATE TRIGGER ledger_append_only BEFORE UPDATE OR DELETE ON ledger FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER audit_append_only  BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON ledger FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER audit_no_truncate  BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
