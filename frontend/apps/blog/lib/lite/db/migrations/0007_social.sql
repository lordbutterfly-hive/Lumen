-- 0007_social.sql — Phase 8: off-chain follows for lite users. Spec §4/§E.4.
-- Lite users have no on-chain follow; recsys builds the graph over user_id.

CREATE TABLE IF NOT EXISTS lumen_follow (
  follower_user_id TEXT NOT NULL REFERENCES lumen_user(user_id) ON DELETE CASCADE,
  followee_user_id TEXT NOT NULL REFERENCES lumen_user(user_id) ON DELETE CASCADE,
  seq              BIGSERIAL,                -- stable cursor for recsys edge pagination
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_user_id, followee_user_id)
);
CREATE INDEX IF NOT EXISTS ix_lumen_follow_seq ON lumen_follow (seq);
CREATE INDEX IF NOT EXISTS ix_lumen_follow_followee ON lumen_follow (followee_user_id);
