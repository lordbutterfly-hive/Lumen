-- ★★★ THE FEED BECOMES OBSERVABLE (2026-08-08).
--
-- Ruling: O:/LUMEN-DOCS/FEED-BALANCE-RULING-2026-08-08.md §6 and §7.
--
-- Two measured gaps, both closed here, and NEITHER of them is the demotion —
-- the `0.85^impressions` rule belongs in the ranker and is deliberately NOT
-- implemented by this migration. This is the INSTRUMENT it will be built and
-- measured against. §6: "Nothing may be declared done on a red instrument."
--
-- GAP 1 — THE STORE THREW AWAY THE ANSWER.
--   recsys's /feed response carries, per post, WHICH LANE surfaced it (`source`:
--   in_network / oon_interest / oon_engaged / exploration / popular_fallback /
--   newcomer …) and its `score.final`. `lumen_feed_store` persisted the assembled
--   `entries` and dropped both. Verified by string-matching every stored row on
--   2026-08-08: has_oon_interest = f, has_in_network = f, has_exploration = f.
--   The lane a post came from therefore existed ONLY inside a transient HTTP
--   response. Nobody could answer "what did the feed actually contain last
--   Tuesday", and the weekly balance probe had to make 8 live HTTP calls (8-35s
--   each) to learn what one SQL query should already know.
--
-- GAP 2 — NOTHING TRACKED WHAT A READER HAD ALREADY SEEN.
--   Two consecutive /feed calls returned a BYTE-IDENTICAL top 20, and 19-20 of
--   20 posts stay eligible tomorrow (the 3-day sourcing window is the only thing
--   that retires them). A reader who opens the app three times a day gets ZERO
--   new information on visits 2 and 3. It also silently voids every discovery
--   budget: reserve 4 slots for popularity and 2 for newcomers, and if they are
--   the same six posts all day you bought 18 impressions of reach and delivered
--   six. Every quota in §7 is a target for ONE PAGE A DAY until this exists.
--
-- ★ SAFE AGAINST THE RUNNING BUILD. Strictly additive: one new column with a
-- default, one new table, one new view. The deployed code SELECTs and INSERTs
-- explicit column lists on `lumen_feed_store`, so a process that has never heard
-- of `lanes` keeps working unchanged while this is applied. That matters here:
-- the app on :3000 is not being rebuilt tonight.

-- ---------------------------------------------------------------------------
-- 1. THE LANE LABEL, KEPT
-- ---------------------------------------------------------------------------
--
-- ★ WHY A SIBLING COLUMN AND NOT A FIELD INSIDE `entries`. Three reasons, in
-- order of how much they cost:
--
--   SIZE. `entries` is the assembled feed: measured 519KB of JSON stored
--   TOAST-compressed at 293,793 bytes per row (`pg_column_size`) at limit=20.
--   Any query of the form `jsonb_array_elements(entries)` must DE-TOAST the
--   whole 287KB for every row it touches — to read three numbers per post. The
--   lane array is ~1.5KB, stays inline, and a lane-composition query never
--   touches the big column at all. The instrument has to be cheap enough that
--   the balance probe actually runs it.
--
--   ALIASING. An `Entry` is a Hive object that came out of a SHARED hydration
--   cache and is spread into new objects on the way to the reader
--   (`mergeLumenEngagement`). Writing our own fields onto it is exactly the
--   shape of the bug that made vote counts climb on every reload — a lane label
--   welded to a cached Hive post would leak into whatever else is holding it.
--
--   THE SERVED POSITION IS NOT A PROPERTY OF THE BUILD. `rank` below is the
--   position IN THE BUILT PAGE. What the reader actually saw can differ — the
--   serve path re-filters banned authors and re-slices to the requested `limit`
--   — so the SERVED position is recorded in `lumen_feed_served`, and the two
--   are deliberately not the same number in the same place.
--
-- Shape: a JSON array PARALLEL TO `keys`, one object per post:
--     [{"key":"author/permlink","source":"oon_interest","score":0.71,"rank":0}, …]
-- `key` uses the same `author/permlink` form as the `keys` column (no leading
-- `@`) so lanes, keys and `lumen_feed_served.post_key` all join without a cast.
--
-- ★ NO `feed_version` BUMP, ON PURPOSE. The store is versioned and a bump
-- retires every row at once — but a missing `lanes` array is not a MISREAD row,
-- it is a row with no lane data, which defaults to `[]` and reads as exactly
-- that. Bumping would make every reader's next load a rebuild to gain an
-- analytics field, against §6's standing requirement that ranking updates be
-- invisible. Rows self-heal into lanes on their next ordinary rebuild (5-minute
-- staleness, 14-day TTL), and until they do the serve log records the post with
-- source = NULL rather than not recording it — an unknown lane must never cost
-- an impression count.
ALTER TABLE lumen_feed_store
  ADD COLUMN IF NOT EXISTS lanes JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Lane composition of every STORED (built) feed, without unnesting in
-- application code. This is the "what did the feed contain" query the balance
-- probe was making 8 live HTTP calls to answer.
--
--   SELECT source, count(*) FROM lumen_feed_lane WHERE viewer = 'steevc'
--   GROUP BY source ORDER BY 2 DESC;
CREATE OR REPLACE VIEW lumen_feed_lane AS
SELECT s.viewer,
       s.feed_version,
       s.built_at,
       s.built_limit,
       l ->> 'key'                 AS post_key,
       nullif(l ->> 'source', '')  AS source,
       (l ->> 'score')::float8     AS score_final,
       (l ->> 'rank')::int         AS rank
  FROM lumen_feed_store s
  CROSS JOIN LATERAL jsonb_array_elements(s.lanes) AS l;

-- ---------------------------------------------------------------------------
-- 2. THE SERVED LOG — what this reader has already been shown
-- ---------------------------------------------------------------------------
--
-- One row per (post, page-serve). All rows written by one response share the
-- same `served_at` (it is `now()`, the transaction timestamp of a single
-- statement), and THAT is what makes a serve event addressable: the last served
-- page is every row at `max(served_at)` for that viewer. No batch id column is
-- needed and none is invented.
--
-- ★ WRITTEN ON SERVE, NEVER ON BUILD. A feed assembled in the background and
-- never delivered was not seen by anybody. The write therefore hangs off the
-- points where a response is actually returned — including the cached and
-- stale-revalidating ones, which are the COMMON case; hooking the build would
-- undercount precisely the readers who come back most often.
--
-- ★ `source` IS NULLABLE AND MUST STAY THAT WAY. It is the lane, copied from
-- the stored `lanes` array. A row stored before this migration has no lane, and
-- the honest record is then "seen at position 4, lane unknown". Refusing to
-- record an impression because we cannot name its lane would break the ONE
-- thing this table exists for.
CREATE TABLE IF NOT EXISTS lumen_feed_served (
  -- Same identity domain as `lumen_feed_store.viewer`: a Hive account name or a
  -- lite ULID, matched EXACTLY (TEXT, not CITEXT — case-folding an identity key
  -- is not something a log gets to do).
  viewer     TEXT        NOT NULL,

  -- `author/permlink`, the same form as `lumen_feed_store.keys` and
  -- `lumen_feed_lane.post_key`. For a lite post this is the DISPLAY identity the
  -- reader actually saw, not the publisher account it lives under on chain,
  -- because the question this table answers is "did this reader see this post".
  post_key   TEXT        NOT NULL,

  served_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- 0-based position in the page as DELIVERED. Not the built rank: the serve
  -- path drops banned authors and re-slices to the requested limit.
  position   SMALLINT    NOT NULL,

  -- The recsys lane (`in_network`, `oon_interest`, `oon_engaged`,
  -- `exploration`, …). NULL = served from a row built before lanes existed.
  source     TEXT,

  -- Also the impression-lookup index: (viewer, post_key) prefix answers "how
  -- many times has this viewer been shown this post", which is what the
  -- 0.85^impressions demotion will ask. Being a PK it additionally makes the
  -- write idempotent under an exact-timestamp collision.
  PRIMARY KEY (viewer, post_key, served_at)
);

-- "What has this viewer seen recently" and "their last served page" — both are
-- a viewer-prefixed descending scan on time.
CREATE INDEX IF NOT EXISTS lumen_feed_served_viewer_recent_idx
  ON lumen_feed_served (viewer, served_at DESC);

-- The TTL cut is a global time predicate and cannot use the index above.
CREATE INDEX IF NOT EXISTS lumen_feed_served_at_idx
  ON lumen_feed_served (served_at);

-- ---------------------------------------------------------------------------
-- SIZE, AND WHY THE BOUNDS ARE SHAPED DIFFERENTLY FROM THE FEED STORE'S
-- ---------------------------------------------------------------------------
--
-- `lumen_feed_store` holds exactly ONE row per viewer, so a global row cap is
-- both fair and sufficient. Here rows-per-viewer is UNBOUNDED — it grows with
-- how often somebody loads the feed — and that changes the bound's shape:
--
--   TTL (FEED_SERVED_TTL_DAYS, default 7)
--       recsys sources from a 3-day window, so a post older than that cannot be
--       re-served and its impression history cannot inform any demotion. 7 days
--       leaves a full week for the weekly balance probe, with margin.
--
--   PER-VIEWER CAP (FEED_SERVED_MAX_ROWS_PER_VIEWER, default 2,000)
--       ~100 recorded pages at limit=20. This is the bound a GLOBAL cap cannot
--       provide: with one shared ceiling, a single heavy or automated viewer
--       evicts every other reader's history — per-user history behind a global
--       limit with no per-user isolation is a griefing primitive, not a bound.
--
--   GLOBAL CAP (FEED_SERVED_MAX_ROWS, default 2,000,000)
--       The disk backstop for viewer-count growth, which neither of the above
--       covers. At ~130 bytes of heap per row plus indexes that ceiling is
--       roughly 300-400MB, against a table whose loss costs nothing but a
--       colder demotion — this log is rebuildable-by-observation, exactly like
--       the feed store, and a cache that cannot forget is a disk-space bug.
--
-- Swept off the request path by `sweepServedFeeds` (feed-served-repository.ts),
-- throttled to at most once per 10 minutes per process, same as the feed store.
--
-- ---------------------------------------------------------------------------
-- THE TWO QUESTIONS THIS TABLE HAS TO BE ABLE TO ANSWER
-- ---------------------------------------------------------------------------
-- Lane composition of one viewer's last served page:
--
--   SELECT source, count(*) AS slots
--     FROM lumen_feed_served
--    WHERE viewer = $1
--      AND served_at = (SELECT max(served_at) FROM lumen_feed_served WHERE viewer = $1)
--    GROUP BY source ORDER BY slots DESC;
--
-- How many of today's top 20 were also in yesterday's (the repetition the
-- ruling measured at 19-20/20 and the demotion has to move):
--
--   WITH pages AS (
--     SELECT served_at, date_trunc('day', served_at) AS d,
--            row_number() OVER (PARTITION BY date_trunc('day', served_at)
--                               ORDER BY served_at DESC) AS rn
--       FROM (SELECT DISTINCT viewer, served_at FROM lumen_feed_served WHERE viewer = $1) x
--   ), latest AS (SELECT d, served_at FROM pages WHERE rn = 1)
--   SELECT count(*) FROM lumen_feed_served a
--     JOIN lumen_feed_served b USING (viewer, post_key)
--    WHERE a.viewer = $1
--      AND a.served_at = (SELECT served_at FROM latest ORDER BY d DESC LIMIT 1)
--      AND b.served_at = (SELECT served_at FROM latest ORDER BY d DESC OFFSET 1 LIMIT 1)
--      AND a.position < 20 AND b.position < 20;
