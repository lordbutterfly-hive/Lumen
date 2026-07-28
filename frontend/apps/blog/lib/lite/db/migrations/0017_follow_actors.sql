-- 0017_follow_actors.sql — following across the two account tiers.
--
-- The graph was lite-only: both sides referenced `lumen_user(user_id)`, so a lite
-- user could follow another lite user and nothing else. That left two of the four
-- possible directions dead — a lite user could not follow a real Hive account, and a
-- Hive user could not follow a lite one (there is nothing on chain to follow, so the
-- chain path cannot serve that case either).
--
-- Each side of an edge is now EITHER a Lumen user id OR a Hive account name, with
-- exactly one set. Two rules make this survive an upgrade:
--
--   * A Lumen user is always stored by `user_id`, which never changes — so when a
--     lite account becomes a Hive account, every edge pointing at it keeps pointing
--     at it, and their whole audience carries over with no rewrite.
--   * A name that belongs to a Lumen user is canonicalised to that user's id on
--     write (`social/follow-actor.ts`), so the same person can never end up as two
--     nodes in the graph.
--
-- Chain-to-chain follows are untouched: those are broadcast to Hive and never reach
-- this table.

-- The old primary key was (follower_user_id, followee_user_id); both columns are now
-- nullable, which a primary key forbids. Dropped by CATALOGUE LOOKUP rather than by
-- guessed name — the same reason 0010 widened its CHECK by definition. This has to
-- happen BEFORE the NOT NULL constraints come off: Postgres refuses to drop NOT NULL
-- from a column that is still part of a primary key.
DO $$
DECLARE pk_name TEXT;
BEGIN
  SELECT conname INTO pk_name
    FROM pg_constraint
   WHERE conrelid = 'lumen_follow'::regclass AND contype = 'p';
  IF pk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE lumen_follow DROP CONSTRAINT %I', pk_name);
  END IF;
END $$;

ALTER TABLE lumen_follow ALTER COLUMN follower_user_id DROP NOT NULL;
ALTER TABLE lumen_follow ALTER COLUMN followee_user_id DROP NOT NULL;
ALTER TABLE lumen_follow ADD COLUMN IF NOT EXISTS follower_hive CITEXT;
ALTER TABLE lumen_follow ADD COLUMN IF NOT EXISTS followee_hive CITEXT;

-- One stable node id per side, so uniqueness and the recsys cursor feed have a single
-- key to work with regardless of which tier the actor is.
ALTER TABLE lumen_follow
  ADD COLUMN IF NOT EXISTS follower_key TEXT
  GENERATED ALWAYS AS (COALESCE('u:' || follower_user_id, 'h:' || lower(follower_hive::text))) STORED;
ALTER TABLE lumen_follow
  ADD COLUMN IF NOT EXISTS followee_key TEXT
  GENERATED ALWAYS AS (COALESCE('u:' || followee_user_id, 'h:' || lower(followee_hive::text))) STORED;

CREATE UNIQUE INDEX IF NOT EXISTS ux_lumen_follow_edge
  ON lumen_follow (follower_key, followee_key);
CREATE INDEX IF NOT EXISTS ix_lumen_follow_followee_key ON lumen_follow (followee_key);

-- Exactly one identity per side. Without this a row could carry both (two different
-- people in one edge) or neither (a null key, silently unfollowable).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'lumen_follow'::regclass AND conname = 'ck_follow_one_follower') THEN
    ALTER TABLE lumen_follow ADD CONSTRAINT ck_follow_one_follower
      CHECK ((follower_user_id IS NULL) <> (follower_hive IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'lumen_follow'::regclass AND conname = 'ck_follow_one_followee') THEN
    ALTER TABLE lumen_follow ADD CONSTRAINT ck_follow_one_followee
      CHECK ((followee_user_id IS NULL) <> (followee_hive IS NULL));
  END IF;
END $$;
