-- 0001_identity.sql — Lumen Lite Accounts, Phase 1 (Foundation): identity & auth.
-- Canonical schema per LUMEN-LITE-ACCOUNTS-SPEC §4. Applied once by the migration
-- runner inside a transaction.

CREATE EXTENSION IF NOT EXISTS citext;

-- ── identity ────────────────────────────────────────────────────────────────
-- A lite account IS a chosen name + a permanent user_id. No eth address, no
-- did:pkh, no secp256k1 key is ever derived (refinement R-ID). user_id (a ULID)
-- survives the ACT upgrade and is what makes "same history, new on-chain account"
-- work (spec §3).
CREATE TABLE IF NOT EXISTS lumen_user (
  user_id              TEXT PRIMARY KEY,                    -- ULID (crypto-random, sortable)
  display_name         CITEXT NOT NULL UNIQUE,              -- chosen Lumen handle; Hive-shaped charset (§B)
  display_name_history JSONB NOT NULL DEFAULT '[]'::jsonb,  -- prior names (old on-chain footers stay explainable)
  avatar_url           TEXT,                                -- Lumen-hosted
  account_tier         TEXT NOT NULL DEFAULT 'lite' CHECK (account_tier IN ('lite','full')),
  hive_account_name    CITEXT UNIQUE,                       -- NULL until ACT upgrade; MUST differ from display_name
  trust_score          SMALLINT NOT NULL DEFAULT 0,         -- §H, drives rate tiers
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','upgraded','banned')),
  suspended_reason     TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  upgraded_at          TIMESTAMPTZ,
  suspended_at         TIMESTAMPTZ,
  -- "pick another name" is firm: the on-chain name never equals the Lumen handle (§F.2)
  CONSTRAINT hive_name_differs_from_display CHECK (
    hive_account_name IS NULL OR lower(hive_account_name) <> lower(display_name)
  )
);

-- One-to-many auth binders (multi-binder recovery). UNIQUE(method, external_ref)
-- guarantees one Google sub / one BTC address maps to exactly one user, ever (§A.1).
CREATE TABLE IF NOT EXISTS lumen_auth_credential (
  credential_id            TEXT PRIMARY KEY,               -- ULID
  user_id                  TEXT NOT NULL REFERENCES lumen_user(user_id) ON DELETE CASCADE,
  method                   TEXT NOT NULL CHECK (method IN ('google_passkey','btc_wallet')),
  external_ref             TEXT NOT NULL,                  -- google: verified sub; btc: lower(address)
  network                  TEXT,                           -- btc only
  webauthn_credential_id   TEXT,                           -- passkey only
  webauthn_public_key_cose BYTEA,                          -- passkey only — captured at registration, never re-trusted from client
  webauthn_sign_count      BIGINT NOT NULL DEFAULT 0,      -- clone/replay detection
  email_ciphertext         BYTEA,                          -- envelope-encrypted (KMS), never displayed
  email_hash               TEXT,                           -- keccak(lower(email)) — abuse-blocklist join only
  device_label             TEXT,
  is_primary               BOOLEAN NOT NULL DEFAULT false,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at             TIMESTAMPTZ,
  CONSTRAINT uq_method_external_ref UNIQUE (method, external_ref)
);
CREATE INDEX IF NOT EXISTS ix_auth_credential_user ON lumen_auth_credential (user_id);
CREATE INDEX IF NOT EXISTS ix_auth_credential_webauthn
  ON lumen_auth_credential (webauthn_credential_id) WHERE webauthn_credential_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_auth_credential_email_hash
  ON lumen_auth_credential (email_hash) WHERE email_hash IS NOT NULL;

-- Single-use, short-TTL challenges. The nonce MUST be single-use + short-TTL
-- server-side — the Altera source never built this; a naive port allows replay (§C.4).
CREATE TABLE IF NOT EXISTS lumen_challenge (
  nonce        TEXT PRIMARY KEY,                           -- crypto-random
  user_id      TEXT REFERENCES lumen_user(user_id) ON DELETE CASCADE,  -- NULL for pre-account login
  purpose      TEXT NOT NULL CHECK (purpose IN ('login','post_attestation','stepup')),
  payload_hash TEXT,                                       -- bound payload for post_attestation (§C.4)
  issued_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  consumed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_challenge_expiry ON lumen_challenge (expires_at) WHERE consumed_at IS NULL;

-- Two-phase name claim: INSERT pending (DB unique index arbitrates concurrent
-- Lumen signups) -> live Hive existence check -> promote to active (§B.2).
CREATE TABLE IF NOT EXISTS name_reservation (
  display_name_norm TEXT PRIMARY KEY,                      -- lower(display_name)
  status            TEXT NOT NULL CHECK (status IN ('pending','active')),
  user_id           TEXT REFERENCES lumen_user(user_id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ                            -- pending expires; active is NULL (never)
);
CREATE INDEX IF NOT EXISTS ix_name_reservation_pending
  ON name_reservation (expires_at) WHERE status = 'pending';

-- keep lumen_user.updated_at fresh
CREATE OR REPLACE FUNCTION lumen_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_lumen_user_touch ON lumen_user;
CREATE TRIGGER trg_lumen_user_touch
  BEFORE UPDATE ON lumen_user
  FOR EACH ROW EXECUTE FUNCTION lumen_touch_updated_at();
