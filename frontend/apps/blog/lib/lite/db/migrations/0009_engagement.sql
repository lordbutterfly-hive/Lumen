-- 0009_engagement.sql — Lumen-local votes & reblogs for lite users.
-- A vote/reblog is attributed to the SIGNING account on Hive, so it cannot be
-- proxied per-user through one frontend account (every lite user would collapse
-- into the frontend account's single vote). Lite engagement is kept off-chain
-- here and feeds the recsys/feed; it becomes real Hive activity only once the
-- user upgrades to their own account. Soft-delete + seq bump mirror lumen_follow
-- so the recsys delta feed re-observes both adds and retractions.

CREATE TABLE IF NOT EXISTS lumen_vote (
  voter_user_id   TEXT NOT NULL REFERENCES lumen_user(user_id) ON DELETE CASCADE,
  target_author   TEXT NOT NULL,      -- Hive author (frontend acct for a lite post)
  target_permlink TEXT NOT NULL,
  weight          INTEGER NOT NULL,   -- -10000..10000 (Hive convention)
  active          BOOLEAN NOT NULL DEFAULT true,
  seq             BIGSERIAL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (voter_user_id, target_author, target_permlink)
);
CREATE INDEX IF NOT EXISTS ix_lumen_vote_seq ON lumen_vote (seq);
CREATE INDEX IF NOT EXISTS ix_lumen_vote_target ON lumen_vote (target_author, target_permlink);

CREATE TABLE IF NOT EXISTS lumen_reblog (
  reblogger_user_id TEXT NOT NULL REFERENCES lumen_user(user_id) ON DELETE CASCADE,
  target_author     TEXT NOT NULL,
  target_permlink   TEXT NOT NULL,
  active            BOOLEAN NOT NULL DEFAULT true,
  seq               BIGSERIAL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (reblogger_user_id, target_author, target_permlink)
);
CREATE INDEX IF NOT EXISTS ix_lumen_reblog_seq ON lumen_reblog (seq);
CREATE INDEX IF NOT EXISTS ix_lumen_reblog_target ON lumen_reblog (target_author, target_permlink);
