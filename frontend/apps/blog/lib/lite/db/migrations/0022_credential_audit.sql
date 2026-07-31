-- 0022_credential_audit.sql — an append-only trail of credential bind/unbind events.
--
-- A lite account IS its linked credentials (no password, no recovery email). Binding a
-- second method has existed since Phase 2, and F-L2 adds the missing UNBIND path so a
-- user can revoke a lost or compromised credential. Both are security-sensitive account
-- changes, so each writes an immutable audit row here: it is the only record of "a
-- sign-in method was added/removed, when" that survives the mutation, and it is what a
-- support/abuse review reads to answer "was this account takeover, or the owner?".
CREATE TABLE IF NOT EXISTS lumen_credential_audit (
  audit_id      TEXT PRIMARY KEY,                                  -- ULID
  user_id       TEXT NOT NULL REFERENCES lumen_user (user_id),
  credential_id TEXT,                                              -- the credential added/removed (may be gone by read time)
  action        TEXT NOT NULL CHECK (action IN ('bind', 'unbind')),
  method        TEXT,                                              -- google_passkey | btc_wallet | evm_wallet
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_credential_audit_user
  ON lumen_credential_audit (user_id, created_at DESC);
