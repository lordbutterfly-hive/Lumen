-- 0011: rolling container posts — the fix for Hive's 1-root-post-per-5-minutes cap.
--
-- Every lite post is published as a COMMENT under a container root post owned by
-- the publishing account. Hive's consensus only applies HIVE_MIN_ROOT_COMMENT_INTERVAL
-- (5 min) when parent_author is empty; a comment is bound by HIVE_MIN_REPLY_INTERVAL
-- (3 s) instead, and `last_root_post` is not advanced by replies
-- (hive_evaluator_social.cpp: comment_evaluator::do_apply). Same mechanism PeakD
-- Snaps / Ecency Waves / InLeo Threads use. Decision 2026-07-27: ALL lite posts go
-- in a container (not just short-form), our own container account, rotate at 1000
-- children.
--
-- The permlink is derived from container_id, so a child's frozen payload can name
-- its parent before the container root is even broadcast; the worker enforces the
-- ordering (a child never publishes under an unpublished container).

CREATE TABLE IF NOT EXISTS lumen_container (
  container_id   TEXT PRIMARY KEY,                     -- ULID
  hive_author    TEXT NOT NULL,                        -- publishing account owning the root post
  hive_permlink  TEXT NOT NULL,                        -- derived: lumen-c-<lower(container_id)>
  status         TEXT NOT NULL CHECK (status IN ('opening', 'open', 'closed')),
  child_count    INT NOT NULL DEFAULT 0,               -- slots reserved (not necessarily published yet)
  max_children   INT NOT NULL,
  opened_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at   TIMESTAMPTZ,                          -- root post confirmed on chain
  closed_at      TIMESTAMPTZ,
  last_error     TEXT,
  CONSTRAINT uq_container_hive UNIQUE (hive_author, hive_permlink)
);

-- At most ONE live container per publishing account: the second concurrent
-- rotation loses this race and retries, instead of silently forking the feed
-- across two containers.
CREATE UNIQUE INDEX IF NOT EXISTS ux_container_live_per_account
  ON lumen_container (hive_author)
  WHERE status IN ('opening', 'open');

CREATE INDEX IF NOT EXISTS ix_container_unpublished
  ON lumen_container (hive_author) WHERE published_at IS NULL;

-- The on-chain parent a post was FIRST published under, pinned forever.
--
-- Hive forbids repointing a comment: hive_evaluator_social.cpp:294 and :302 both
-- assert "The parent of a comment cannot change." So an edit MUST reuse the exact
-- container the create used — re-resolving "the current open container" at edit
-- time would name a rotated container and the chain would reject the update
-- outright. Written once, on first publish; never updated after (COALESCE guard in
-- post-repository.pinPublishParent).
ALTER TABLE lumen_post ADD COLUMN IF NOT EXISTS publish_parent_author TEXT;
ALTER TABLE lumen_post ADD COLUMN IF NOT EXISTS publish_parent_permlink TEXT;
