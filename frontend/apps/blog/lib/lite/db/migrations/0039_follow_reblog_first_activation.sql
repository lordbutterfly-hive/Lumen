-- 0039 — an IMMUTABLE first-activation timestamp for follows and reblogs.
--
-- WHY. `facts-query.ts` builds a user's act-days from a UNION over four sources. Three of
-- them are honest; two are not:
--
--   lumen_post.created_at    — an insert, never rewritten. Fine.
--   lumen_vote.first_cast_at — pinned by migration 0025, precisely to stop this. Fine.
--   lumen_reblog.created_at  — REWRITTEN to now() on every re-reblog.
--   lumen_follow.created_at  — REWRITTEN to now() on every re-follow.
--
-- Both write sites use `ON CONFLICT ... DO UPDATE SET active = true, seq = <next>,
-- created_at = now()`, so unfollow-then-refollow mints a brand-new activity day out of one
-- gesture, repeatable daily, with no second party involved. 0025 closed exactly this for
-- votes and the neighbouring two sources were never swept.
--
-- WHAT THIS DOES NOT DO, DELIBERATELY.
--
--   1. `created_at` KEEPS its current meaning ("when did this edge last become active")
--      and keeps being rewritten. It is read by the recsys delta feed alongside `seq`;
--      redefining it would break that consumer. This column is strictly additive.
--
--   2. The "X followed you" bell is NOT re-pointed at this column, and that is the whole
--      reason it is out of scope here. The bell's unread test is `date > seenAt`
--      (`use-lumen-notifications.ts`), so feeding it an immutable first-activation date
--      would make a genuinely NEW follow on a previously-active edge carry an old
--      timestamp, fail the test, and never light the bell at all. Trading a duplicate
--      notification for a silently missing one is a worse bug than the one being fixed.
--      The bell needs per-actor dedup instead; that is a separate change.
--
-- HONEST LIMIT OF THE BACKFILL. For any edge that has already been toggled, `created_at`
-- is the LAST activation, not the first, and the true first is unrecoverable. So historical
-- act-days do not move, but a user whose only activity today was a re-follow loses today's
-- act-day the moment this ships. That is the fix working, and it should be stated rather
-- than discovered by the user. Same limitation 0025 recorded for votes.

ALTER TABLE lumen_follow ADD COLUMN IF NOT EXISTS first_created_at TIMESTAMPTZ;
UPDATE lumen_follow SET first_created_at = created_at WHERE first_created_at IS NULL;
ALTER TABLE lumen_follow ALTER COLUMN first_created_at SET DEFAULT now();
ALTER TABLE lumen_follow ALTER COLUMN first_created_at SET NOT NULL;

ALTER TABLE lumen_reblog ADD COLUMN IF NOT EXISTS first_created_at TIMESTAMPTZ;
UPDATE lumen_reblog SET first_created_at = created_at WHERE first_created_at IS NULL;
ALTER TABLE lumen_reblog ALTER COLUMN first_created_at SET DEFAULT now();
ALTER TABLE lumen_reblog ALTER COLUMN first_created_at SET NOT NULL;

-- Immutability is enforced in the DATABASE, not by convention — same argument 0025 makes:
-- a column whose whole value is that it never moves must not depend on every future writer
-- remembering that. This fires on the `seq`/`created_at` bump too, which is the point.
CREATE OR REPLACE FUNCTION lumen_pin_first_created() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.first_created_at := OLD.first_created_at;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lumen_follow_pin_first_created ON lumen_follow;
CREATE TRIGGER trg_lumen_follow_pin_first_created
  BEFORE UPDATE ON lumen_follow
  FOR EACH ROW EXECUTE FUNCTION lumen_pin_first_created();

DROP TRIGGER IF EXISTS trg_lumen_reblog_pin_first_created ON lumen_reblog;
CREATE TRIGGER trg_lumen_reblog_pin_first_created
  BEFORE UPDATE ON lumen_reblog
  FOR EACH ROW EXECUTE FUNCTION lumen_pin_first_created();

-- The act-day union reads (follower_user_id, first_created_at) and
-- (reblogger_user_id, first_created_at); these keep that scan index-only.
CREATE INDEX IF NOT EXISTS ix_lumen_follow_follower_first_created
  ON lumen_follow (follower_user_id, first_created_at) WHERE follower_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_lumen_reblog_reblogger_first_created
  ON lumen_reblog (reblogger_user_id, first_created_at);
