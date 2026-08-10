-- 0030_block.sql — BLOCKING, for both account tiers, with TWO distinct effects.
--
-- Muting on Lumen was, until now, Hive's on-chain `ignore` follow: only a full Hive
-- account could write one (a lite account has no key to sign with), it could only
-- name another Hive account (a lite handle is not an account), and it did exactly
-- one thing — collapse that person's comments behind an accordion IN THE MUTER'S OWN
-- BROWSER. Nothing about it ever reached another reader.
--
-- A block is a different instrument and needs its own table:
--
--   (A) VIEWER-SIDE. I never see the blocked account again — not in a feed, not in
--       a thread, not on a profile.
--   (B) OWNER-SIDE. Their comments UNDER MY CONTENT stop being served to EVERYONE,
--       not just to me. That is a statement about my post, so it cannot live in a
--       per-viewer preference and it cannot be enforced in a browser.
--
-- Effect (B) is why this is Lumen-local for BOTH tiers rather than an on-chain
-- `ignore` for full accounts: Hive's mute has no way to express "hide this person's
-- replies from third parties", so writing one would record a weaker promise than the
-- button makes, and would behave differently for the two kinds of account holding
-- the same button. See `social/block-service.ts` for the full reasoning.
--
-- SHAPE: copied deliberately from `0017_follow_actors.sql`, because a block has the
-- same four directions a follow does and the same upgrade problem:
--
--   * Each side is EITHER a Lumen user id OR a Hive account name, exactly one set.
--   * A Lumen user is stored by `user_id`, which survives an upgrade to a real Hive
--     account — so a block written before the upgrade still binds afterwards, in
--     both directions. Storing names would silently release every block the moment
--     either party upgraded.
--   * A name that belongs to a Lumen user is canonicalised to that id on write
--     (`social/follow-actor.ts:resolveFollowTarget`), so one person is never two
--     nodes.
--
-- TOMBSTONE, not delete (same rule as 0008 for follows): unblocking flips `active`
-- and re-draws `seq`, so a cursor-based consumer re-observes the edge and can RETRACT
-- it. A hard delete leaves a consumer holding a block that no longer exists, with
-- nothing to tell it otherwise.

CREATE TABLE IF NOT EXISTS lumen_block (
  blocker_user_id TEXT REFERENCES lumen_user(user_id) ON DELETE CASCADE,
  blocker_hive    CITEXT,
  blocked_user_id TEXT REFERENCES lumen_user(user_id) ON DELETE CASCADE,
  blocked_hive    CITEXT,
  seq             BIGSERIAL,
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One stable node id per side, so every lookup, the uniqueness rule and any
  -- cursor feed all key on a single value regardless of which tier the actor is.
  blocker_key TEXT
    GENERATED ALWAYS AS (COALESCE('u:' || blocker_user_id, 'h:' || lower(blocker_hive::text))) STORED,
  blocked_key TEXT
    GENERATED ALWAYS AS (COALESCE('u:' || blocked_user_id, 'h:' || lower(blocked_hive::text))) STORED,

  -- Exactly one identity per side. Without these a row could carry both (two
  -- different people on one side of the edge) or neither (a NULL key, which no
  -- query would ever match and no user could ever undo).
  CONSTRAINT ck_block_one_blocker CHECK ((blocker_user_id IS NULL) <> (blocker_hive IS NULL)),
  CONSTRAINT ck_block_one_blocked CHECK ((blocked_user_id IS NULL) <> (blocked_hive IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_lumen_block_edge ON lumen_block (blocker_key, blocked_key);

-- (A) reads all of one viewer's blocks on every feed request; (B) reads "did any of
-- these thread ancestors block any of these comment authors" on every thread render.
-- Both are hot and both only ever want live edges, so the tombstones stay out of the
-- indexes entirely.
CREATE INDEX IF NOT EXISTS ix_lumen_block_blocker ON lumen_block (blocker_key) WHERE active;
CREATE INDEX IF NOT EXISTS ix_lumen_block_blocked ON lumen_block (blocked_key) WHERE active;
CREATE INDEX IF NOT EXISTS ix_lumen_block_seq ON lumen_block (seq);
