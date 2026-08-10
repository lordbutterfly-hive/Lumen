-- 0025 — Lumen-native retention/league support.
--
-- The chain league (features/retention/**) is derived entirely from Hive facts, so
-- `use-retention.ts` disables it for lite accounts: a lite user has no chain account,
-- therefore no tenure, no streak, no rank. This migration adds the three things the
-- Postgres-side ladder needs that the schema could not already answer.
--
--   1. lumen_vote.first_cast_at — an IMMUTABLE first-cast timestamp (see below).
--   2. lumen_permlink_post_id() — the placeholder/published permlink resolver, plus
--      expression indexes so "who engaged my posts" is an index lookup.
--   3. Actor-side (user, time) indexes so "which UTC days did I act on" is index-only.
--
-- No column is dropped and no existing writer changes behaviour.


-- ---------------------------------------------------------------------------
-- 1. lumen_vote.first_cast_at — the immutable act timestamp
-- ---------------------------------------------------------------------------
-- lumen_vote carried ONLY `updated_at`, and engagement-repository.castVote bumps it
-- on every re-vote (`ON CONFLICT ... DO UPDATE SET ... updated_at = now()`). A streak
-- built on `updated_at` is therefore lossy at the schema level in BOTH directions:
--
--   * it FORGETS the day the vote was actually cast (re-vote on day 5 erases day 1), and
--   * it is FARMABLE — toggling one single vote off/on every day would tick the streak
--     every day forever, from one act. `removeVote` + `castVote` is two API calls.
--
-- `first_cast_at` records when this (voter, target) pair FIRST became an act and never
-- moves again. That is both the more correct streak semantic (the act happened once)
-- and the non-farmable one (re-voting the same target mints no new day). `updated_at`
-- is left untouched for everything that legitimately wants "last changed".
--
-- Backfilled from `updated_at`: for the 31 rows present at migration time that is the
-- best available estimate and is exact for every vote never re-cast. It is an estimate,
-- not a measurement, for any row that was — which is precisely the loss this closes.
ALTER TABLE lumen_vote ADD COLUMN IF NOT EXISTS first_cast_at TIMESTAMPTZ;
UPDATE lumen_vote SET first_cast_at = updated_at WHERE first_cast_at IS NULL;
ALTER TABLE lumen_vote ALTER COLUMN first_cast_at SET DEFAULT now();
ALTER TABLE lumen_vote ALTER COLUMN first_cast_at SET NOT NULL;

-- Immutability is enforced in the DATABASE, not by convention. Today no writer sets
-- the column (so the DEFAULT applies on INSERT and the value survives ON CONFLICT DO
-- UPDATE untouched) — but "no writer touches it yet" is not a guarantee, and a column
-- whose whole value is that it never moves must not depend on every future writer
-- remembering that. The trigger pins it for all of them.
CREATE OR REPLACE FUNCTION lumen_vote_pin_first_cast() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.first_cast_at := OLD.first_cast_at;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lumen_vote_pin_first_cast ON lumen_vote;
CREATE TRIGGER trg_lumen_vote_pin_first_cast
  BEFORE UPDATE ON lumen_vote
  FOR EACH ROW EXECUTE FUNCTION lumen_vote_pin_first_cast();


-- ---------------------------------------------------------------------------
-- 2. Resolving an engagement target back to the Lumen post that received it
-- ---------------------------------------------------------------------------
-- ★ A LUMEN POST HAS TWO NAMES, AND RECEIVED ENGAGEMENT IS RECORDED UNDER BOTH.
--
-- publisher/worker.ts documents it: a post is written locally under the placeholder
-- permlink `lite-<ulid>` (what Lumen's own URLs use before it reaches Hive) and the
-- publisher later broadcasts it as `lumen-<ulid>` (publisher/permlink.ts buildPermlink).
-- Votes, reblogs and replies capture whichever name was on screen at the time, and
-- `target_author` is likewise sometimes the publisher account and sometimes the lite
-- user's display name.
--
-- MEASURED on the live QA database (176 accounts): joining engagement back to authors
-- on (hive_author, hive_permlink) — the only mapping the schema offered — finds 1 of
-- the 6 authors who have actually received something. Resolving the permlink to the
-- ULID instead finds all 6. The other 5 were invisible, not absent.
--
-- Deriving post_id from the permlink is exact (the ULID IS the post_id, lowercased),
-- author-agnostic, and a primary-key lookup. NULL for any foreign Hive permlink
-- (`beersaturday-472-winners`) and for container permlinks (`lumen-c-<ulid>`, which
-- fail the 26-char ULID class), so those simply never join.
CREATE OR REPLACE FUNCTION lumen_permlink_post_id(permlink TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT upper(substring(permlink FROM '^(?:lite|lumen)-([0-9A-Za-z]{26})$'))
$$;

-- Received-engagement lookups: "which of MY posts did this row target".
CREATE INDEX IF NOT EXISTS ix_lumen_vote_target_post
  ON lumen_vote (lumen_permlink_post_id(target_permlink))
  WHERE active AND weight > 0;

CREATE INDEX IF NOT EXISTS ix_lumen_reblog_target_post
  ON lumen_reblog (lumen_permlink_post_id(target_permlink))
  WHERE active;

CREATE INDEX IF NOT EXISTS ix_lumen_post_parent_post
  ON lumen_post (lumen_permlink_post_id(parent_ref ->> 'permlink'))
  WHERE parent_ref IS NOT NULL AND deleted_locally = false;


-- ---------------------------------------------------------------------------
-- 3. Actor-side (user, day) indexes
-- ---------------------------------------------------------------------------
-- "Which UTC days did this user act on" reads four tables. Three already have the
-- user as a primary-key prefix, but none carries the timestamp, so every day-set
-- query had to visit the heap. lumen_follow had NO follower-side index at all
-- (only ix_lumen_follow_followee), so the follow arm was a sequential scan.
CREATE INDEX IF NOT EXISTS ix_lumen_post_user_created_at
  ON lumen_post (user_id, created_at);

CREATE INDEX IF NOT EXISTS ix_lumen_vote_voter_first_cast
  ON lumen_vote (voter_user_id, first_cast_at);

CREATE INDEX IF NOT EXISTS ix_lumen_reblog_reblogger_created
  ON lumen_reblog (reblogger_user_id, created_at);

CREATE INDEX IF NOT EXISTS ix_lumen_follow_follower_created
  ON lumen_follow (follower_user_id, created_at)
  WHERE follower_user_id IS NOT NULL;
