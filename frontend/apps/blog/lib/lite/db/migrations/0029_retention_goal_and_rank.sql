-- 0029 — the daily goal becomes real, and the rank becomes readable in bulk.
--
-- Two tables, each forced by one owner instruction (2026-08-09).
--
-- ═══ 1. THE GOAL NOW GATES THE STREAK, SO IT CANNOT LIVE IN localStorage ═══
--
-- `daily-goal.ts` stored the chosen goal in browser storage and said so plainly: "it
-- measures nothing... editing it in localStorage changes the ring you look at and
-- nothing else". A council seat read that and called the picker decorative, which was
-- correct and which contradicted this feature's own design doc ("the streak ticks when
-- the goal is met, not on the first act").
--
-- Wiring it means the goal now decides whether TODAY counts toward a chain-derived
-- streak. That moves it from cosmetic to load-bearing, and a load-bearing number must
-- not be client-supplied — otherwise the streak, the one figure deliberately kept
-- unforgeable, becomes editable from a devtools console.
--
-- ★ KEYED BY ACCOUNT TEXT, COVERING BOTH IDENTITIES. A Hive reader is a chain name; a
-- lite user is a ULID. `lumen_hive_reader_prefs` only holds the former and `lumen_user`
-- only the latter, so a goal column on either would cover half the audience. One
-- table, one key domain, matching how `lumen_feed_store.viewer` already spans both.
CREATE TABLE IF NOT EXISTS lumen_retention_goal (
  -- Hive account name, or a lite user's ULID. Matched exactly.
  account    TEXT        PRIMARY KEY,

  -- Authored acts per day the reader committed to. Bounded so a corrupt or hostile
  -- write cannot set a goal nobody can meet (which would silently kill their streak)
  -- or one that is met by nothing (0, which would make every day count for free).
  goal       SMALLINT    NOT NULL CHECK (goal >= 1 AND goal <= 20),

  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ═══ 2. THE BYLINE MARK NEEDS A RANK THAT COSTS NOTHING TO READ ═══
--
-- `league-byline.tsx` has been mounted nowhere since 2026-08-08, and its own comment
-- explains why: the feed once fed it `bylineTierFromReputation(post.author_reputation)`,
-- a DIFFERENT function from the profile's, so one person carried two contradicting ranks
-- in one session. The comment states the only acceptable fix — "the rung must come from
-- the same source the profile uses... A feed of N authors means N of those lookups, so
-- the honest fix is a BATCH endpoint".
--
-- A batch endpoint over the live route would be catastrophic: a 20-author page would fan
-- ~50 Hive calls PER AUTHOR. So this table is the batch endpoint's entire data source —
-- it is written as a side effect whenever `/api/streak/[user]` computes a rank for real,
-- and read by a pure SELECT that never touches Hive.
--
-- ★ THE HONEST CONSEQUENCE, STATED: an author whose rank has never been computed has no
-- row, so no mark renders for them. Marks therefore appear progressively — an author
-- gets one once anybody has viewed their profile or they have visited themselves. That
-- is a real limitation and it is strictly better than the two alternatives: fanning out
-- (unaffordable) or deriving a second cheaper rank (the exact bug that unmounted this
-- component). ABSENT IS NOT ZERO: a missing row means "not computed", never "rung 1".
CREATE TABLE IF NOT EXISTS lumen_hive_rank (
  account      CITEXT      PRIMARY KEY,

  -- The tier id (`spark`…`lumen`), as `LeagueTier` serialises it.
  tier         TEXT        NOT NULL,
  -- 1..9. Stored alongside the tier so a reader needs no tier table to sort or display.
  rank_number  SMALLINT    NOT NULL CHECK (rank_number >= 1 AND rank_number <= 9),
  -- Denormalised from the ladder so the feed can decide whether to draw anything at all
  -- without importing the tier metadata. The ladder owns the rule; this is a snapshot.
  show_mark    BOOLEAN     NOT NULL,

  -- ★ REQUIRED FOR STALENESS, NOT DECORATION. A rank decays on long absence, so a row
  -- computed months ago may name a rung the account no longer holds. The reader applies
  -- a TTL and shows nothing rather than a stale claim — a wrong mark is worse than none,
  -- which is the whole lesson of the contradicting-ranks bug this table exists to avoid.
  computed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The batch read is "give me these N accounts" (PK) and the sweeper is "what is stale"
-- (time). The PK covers the first; this covers the second.
CREATE INDEX IF NOT EXISTS lumen_hive_rank_computed_idx ON lumen_hive_rank (computed_at);
