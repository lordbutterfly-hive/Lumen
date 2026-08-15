-- ★★★ WHEN WAS THIS READER HERE — the activity signal the warmer needs, and the
-- one it may NOT take from any table that already exists (2026-08-15).
--
-- BUILD MAP: O:/LUMEN-DOCS/BUILDMAP-NEVER-WAIT-2026-08-15.md §4.2.
--
-- THE DEADLOCK THIS BREAKS, MEASURED. `recordFeedServe` is called from exactly
-- two places, both on the PERSONAL RANKED branches of /api/feed/for-you — the
-- trending fallback records nothing. So a returning daily reader, who is always
-- served trending because their stored row is past the presentation ceiling, is
-- INVISIBLE to the served log. Measured on this box for `lordbutterfly`: the
-- stored row was rebuilt at 2026-08-14 20:03:06Z and the served log's newest row
-- for them is 2026-08-14 03:52:33Z — a 16h 11m gap. A build ran for that reader
-- and nothing was ever shown to them.
--
-- That is circular: the warmer cannot see them because they are stale, and they
-- stay stale because the warmer cannot see them. Re-verified 2026-08-15 against
-- this database: 52 rows in `lumen_feed_store`, 1 younger than 18h, 2 younger
-- than 72h, 50 past 72h. Essentially every signed-in reader on this box would be
-- served trending on their next visit.
--
-- ★★★ WHY NOT `lumen_feed_store.built_at`, WHICH IS ALREADY HERE AND FREE.
-- Because the warmer writes it. `writeViewerFeed` stamps `built_at = now()` on
-- every write (feed-store-repository.ts:141-157), so the moment a warmer exists,
-- `built_at` stops being evidence that a READER came back and becomes evidence
-- that the WARMER ran. The signal would then select the viewers the warmer has
-- most recently warmed, forever, and drop the ones it has not — a loop that
-- feeds on its own output. It works perfectly today and breaks silently on the
-- day it ships, which is the worst shape a signal can have.
--
-- ★★★ WHY NOT A ROW IN `lumen_feed_served`, WHICH WOULD NEED NO MIGRATION.
-- Because ACTIVITY IS NOT AN IMPRESSION, and that boundary is load-bearing for
-- the seen-suppression feature being built in parallel. `lumen_feed_served`
-- answers "what was this reader SHOWN"; a row there means a post was delivered
-- to a person. This table answers "when was this reader HERE". Writing activity
-- into the served log would inject rows representing no delivered post and
-- corrupt the only instrument that feature has. `lumen_feed_served` also has a
-- second, live consumer — `countFeedsReachedWithPrior`
-- (hive-retention-repository.ts:323) counts DISTINCT viewers per author for the
-- "landed in N feeds" number on the profile — so a synthetic row there would
-- inflate a number shown to an author about their own reach.
--
-- ONE ROW PER VIEWER, ONE UPSERT PER FOREGROUND REQUEST. Row count grows with
-- distinct viewers, never with traffic.
CREATE TABLE IF NOT EXISTS lumen_feed_viewer_seen (
  -- Same identity domain as `lumen_feed_store.viewer` and
  -- `lumen_feed_served.viewer`: a Hive account name or a lite handle, matched
  -- EXACTLY (TEXT, not CITEXT — case-folding an identity key is not something
  -- an activity log gets to do). The join to `lumen_feed_store` in the warmer's
  -- selection query depends on that being the same string.
  viewer       TEXT        PRIMARY KEY,

  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- ★ THE IDENTITY AS THE SESSION RESOLVED IT, NOT AS A NAME LOOKUP GUESSES IT.
  -- The build map's §4.4 rule 5 has the warmer re-derive `isLite`/`userId` from
  -- `lumen_user` by viewer name. Recording them at the one moment they are known
  -- for certain — the request that read the sealed session cookie — is strictly
  -- more accurate and one query cheaper per warmed viewer. It matters because
  -- the name spaces are not provably disjoint: a lite handle is by construction
  -- a name that was FREE on Hive at signup (user-repository.ts:146-150), which
  -- says nothing about whether someone registered it on Hive afterwards. A
  -- reverse lookup could therefore hand a Hive reader's warm build the follow
  -- graph and block list of an unrelated Lumen account. These two columns make
  -- that impossible by construction rather than unlikely by argument.
  --
  -- `user_id` is NULL for a Hive-keyed reader, which is exactly what the request
  -- path passes (`collectViewerState`'s non-lite branch never reads it).
  is_lite      BOOLEAN     NOT NULL DEFAULT false,
  user_id      TEXT
);

-- The warmer's selection is "most recently active first, inside a window", so
-- it is a descending scan on this column. The `viewer` side of its LEFT JOIN to
-- `lumen_feed_store` is that table's primary key and needs no index here.
CREATE INDEX IF NOT EXISTS lumen_feed_viewer_seen_recent_idx
  ON lumen_feed_viewer_seen (last_seen_at DESC);

-- ---------------------------------------------------------------------------
-- BOUNDS
-- ---------------------------------------------------------------------------
-- One row per viewer ever signed in, so this grows with the SIZE OF THE
-- AUDIENCE and nothing else — no TTL is needed to keep it from exploding under
-- traffic. It is still swept (`sweepViewerSeen`, FEED_SEEN_TTL_DAYS, default
-- 30) for the same reason `pruneGenerations` exists in feed-cache.ts:479-502: a
-- structure that is only ever written to is real growth on a long-lived
-- process, and rows outside the 48h active window can never be selected again
-- anyway. Losing this table costs one cold cycle, never data.
--
-- ★ AND IT IS AN ERASURE SURFACE. A table of "when was this named person last
-- here" gets a delete path on the day it is created, not the day it is asked
-- for — same posture as `deleteServedHistory`.
