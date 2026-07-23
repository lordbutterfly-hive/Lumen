-- 0006_upgrade.sql — Phase 7: lite -> full Hive account upgrade audit. Spec §F.

CREATE TABLE IF NOT EXISTS upgrade_event (
  id                  TEXT PRIMARY KEY,                 -- ULID
  user_id             TEXT NOT NULL REFERENCES lumen_user(user_id) ON DELETE CASCADE,
  hive_account_name   TEXT NOT NULL,                    -- the freshly chosen on-chain name
  status              TEXT NOT NULL DEFAULT 'creating'
                        CHECK (status IN ('creating','created','settled','failed')),
  create_trx_id       TEXT,
  settlement_batch_id TEXT,
  last_error          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_upgrade_event_user ON upgrade_event (user_id);
