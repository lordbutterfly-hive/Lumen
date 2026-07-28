-- 0014: a moderation trail.
--
-- `lumen_user.status` accepted 'suspended'/'banned' and `lumen_post.feed_visibility`
-- accepted 'author_only'/'hidden' from migration 0001/0002 onward, but NOTHING ever
-- wrote those values: the moderation model existed on paper only. The writers landed
-- with this migration; this table is what makes them accountable.
--
-- Every moderation action is recorded, including the ones that undo an earlier one.
-- A moderation system without a log is not a moderation system — you cannot answer
-- "who hid this, and why" three months later, and a shared operator token means the
-- database is the only place that answer can live.

CREATE TABLE IF NOT EXISTS lumen_moderation_action (
  action_id    TEXT PRIMARY KEY,
  -- Free text supplied by the operator, not a foreign key: there is no admin account
  -- model yet, and pretending otherwise would make the log look more trustworthy
  -- than it is. It is an attribution hint alongside the shared token.
  actor        TEXT NOT NULL,
  target_type  TEXT NOT NULL CHECK (target_type IN ('user', 'post')),
  target_id    TEXT NOT NULL,
  action       TEXT NOT NULL,
  reason       TEXT,
  -- Consequences that were applied alongside the action (jobs parked, posts hidden,
  -- chain takedown queued), so the log records what actually happened, not just what
  -- was asked for.
  detail       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "What has been done to this user/post" — the question an appeal starts with.
CREATE INDEX IF NOT EXISTS ix_moderation_target
  ON lumen_moderation_action (target_type, target_id, action_id DESC);

-- "What happened recently" — the review queue.
CREATE INDEX IF NOT EXISTS ix_moderation_recent
  ON lumen_moderation_action (action_id DESC);

-- Suspension parks a user's not-yet-broadcast posts instead of cancelling them, so
-- reinstating is a real undo. 'holding' was already a legal publish_job status with
-- no writer; this is the writer. Partial index because the parked set is small and
-- reinstate looks it up by user via lumen_post.
CREATE INDEX IF NOT EXISTS ix_publish_job_holding
  ON publish_job (post_id) WHERE status = 'holding';
