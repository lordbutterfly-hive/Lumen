-- 0015_key_reveal.sql — durable, encrypted reveal-once outbox for the lite -> full upgrade.
--
-- WHY THIS TABLE EXISTS. `create_claimed_account` is irreversible and the master
-- password is random, never stored, and never derivable again. Before this table the
-- ONLY copy of a brand-new account's keys was the body of one HTTP response: a dropped
-- connection, a closed tab, a crashed render or a timeout locked the user out of an
-- account we had just burned an account-creation token to make — permanently, with no
-- recovery path for them or for us.
--
-- ORDERING IS THE WHOLE DESIGN: the row is written BEFORE the account is created.
--  * insert fails      -> nothing was created, nothing is stranded, clean refusal.
--  * creation fails    -> the row is a harmless orphan for an account that does not
--                         exist (kept, not deleted: an ambiguous broadcast timeout may
--                         still have landed on chain, and then these are the real keys).
--  * response is lost  -> the user re-fetches until they acknowledge receipt.
--
-- Ciphertext is AES-256-GCM under LITE_KEY_REVEAL_ENCRYPTION_KEY, which this
-- application never persists, and is NULLed the moment the user acknowledges — so
-- private keys are at rest only for the window between creation and acknowledgement.

CREATE TABLE IF NOT EXISTS key_reveal (
  reveal_id         TEXT PRIMARY KEY,                 -- ULID
  user_id           TEXT NOT NULL REFERENCES lumen_user(user_id) ON DELETE CASCADE,
  upgrade_event_id  TEXT NOT NULL REFERENCES upgrade_event(id) ON DELETE CASCADE,
  hive_account_name TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending_create'
                      CHECK (status IN ('pending_create','available','uncertain','acknowledged','expired')),
  -- iv(12) || authTag(16) || ciphertext. NULL once acknowledged or expired; the row
  -- itself is kept as the audit record of a reveal having happened.
  ciphertext        BYTEA,
  create_trx_id     TEXT,
  fetch_count       INTEGER NOT NULL DEFAULT 0,
  last_fetched_at   TIMESTAMPTZ,
  acknowledged_at   TIMESTAMPTZ,
  expires_at        TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The lookup both the upgrade path and the reveal endpoint make: "does this user have
-- keys still owed to them?" Partial on ciphertext, because acknowledged and expired
-- rows are history and must never be handed back.
CREATE INDEX IF NOT EXISTS ix_key_reveal_outstanding
  ON key_reveal (user_id, created_at DESC)
  WHERE ciphertext IS NOT NULL;

-- Drives the expiry sweep without scanning acknowledged history.
CREATE INDEX IF NOT EXISTS ix_key_reveal_expiry
  ON key_reveal (expires_at)
  WHERE ciphertext IS NOT NULL;
