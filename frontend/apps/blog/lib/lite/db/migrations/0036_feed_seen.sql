-- ★★★★ SEEN-POST SUPPRESSION — THE IMPRESSION STATE (2026-08-15).
--
-- BUILD MAP: O:/LUMEN-DOCS/BUILDMAP-SEEN-SUPPRESSION-2026-08-15.md
-- OWNER'S DESIGN: suppress a post only after it has been SERVED TWICE, and
-- resurrect it if engagement grows. Deliberately NOT X's remove-on-first-sight:
-- our supply is small enough that first-sight removal empties feeds.
--
-- ---------------------------------------------------------------------------
-- WHY A NEW TABLE AND NOT A COLUMN ON `lumen_feed_served`
-- ---------------------------------------------------------------------------
--
-- Three properties of the existing log that a RANKING INPUT cannot have. Each is
-- measured against this database, read-only, on 2026-08-15.
--
-- 1. ★★★ ITS SEMANTICS ARE ALREADY SPENT — 8,508 ROWS OF THEM.
--    `lumen_feed_served` holds 8,508 rows across 44 viewers
--    (2026-08-08 16:32:36Z .. 2026-08-14 03:52:33Z), and they were written under
--    a definition that no longer applies. Until 2026-08-15 the 3-minute client
--    poll re-fetched page 1 through the recording path, so the counter read
--    31-40 recorded impressions per DISTINCT post per viewer — roughly 31 for 1.
--    Under this feature's rule those are not impressions; they are machine
--    traffic. Arming a 2-impression rule against them would suppress 531 of
--    1,192 (viewer, post) pairs — 44.5% — on day one, for posts the reader may
--    never have looked at. That is the feature destroying feeds on the day it
--    ships, and refusing it is the correct call.
--
--    ★ THEY ARE VERSIONED OFF, NOT BACKFILLED AND NOT DELETED.
--
--    NOT BACKFILLED, because there is nothing to backfill FROM. The
--    distinguishing fact — "was this request a poll?" — was never captured, and
--    it is not recoverable after the event: the poll and a real page-1 fetch
--    were THE SAME URL WITH THE SAME PARAMETERS, so the rows are byte-identical
--    in every column this table has. A heuristic ("drop serves ~180s after the
--    previous one") would be inventing the answer and would be wrong in both
--    directions — a reader who reloads at 3 minutes is discarded, a poll at 200s
--    is kept. A field that was never captured cannot be reconstructed from the
--    rows that lack it.
--
--    NOT DELETED, because `lumen_feed_served` has a SECOND, LIVE CONSUMER:
--    `countFeedsReachedWithPrior` (hive-retention-repository.ts) answers the
--    author-facing "your posts landed in N feeds" over a 14-day scan. Truncating
--    would zero every author's reach number to clean up a different feature's
--    input. Not a trade worth making, and not necessary.
--
--    VERSIONED: `lumen_feed_seen` below starts EMPTY and is written only by
--    deliveries that satisfy the corrected definition. The legacy rows stay
--    exactly where they are, keep serving author reach, and are NEVER READ by
--    suppression. The cost is stated plainly: suppression has no history on the
--    day it is built, and the first two impressions of every post start accruing
--    from the moment the instrument was corrected. Those are the first two
--    impressions that were ever measured under the rule.
--
--    THE CUTOVER, for whoever reads this table later and wonders where the
--    boundary is: every row in `lumen_feed_seen` postdates this migration, and
--    `first_served_at` records it per row. The probe fix that makes the counter
--    honest landed earlier the same day (`probe=1` in
--    `app/api/feed/for-you/route.ts`; `recordFeedServe` is called only on
--    non-probe deliveries).
--
-- 2. THE LOG SILENTLY FORGETS. `FEED_SERVED_MAX_ROWS_PER_VIEWER` defaults to
--    2,000 and deletes oldest-first, and the three heaviest viewers are sitting
--    at EXACTLY 2,000 right now — they are being truncated as this is written. A
--    suppression filter reading a table that forgets without telling anyone
--    would resurrect posts by amnesia and call it freshness. This aggregate is
--    bounded by DISTINCT POSTS SEEN IN THE WINDOW, measured at 50-66 for those
--    same three viewers over six days — two orders of magnitude below the cap
--    that bites the log, so the cap cannot bite it.
--
-- 3. IT HAS NO ENGAGEMENT COLUMN AND CANNOT CHEAPLY GAIN ONE. The resurrection
--    rule needs the engager count AT THE MOST RECENT SERVE. On an append-only
--    log that is a window function over every row for the pair, on every build,
--    for every candidate. On an aggregate it is a column read.
--
-- ★ SAFE AGAINST THE RUNNING BUILD. Strictly additive — two nullable columns
-- with no default and one new table. Every deployed writer uses explicit column
-- lists, so a process that has never heard of these keeps working unchanged.
-- This is the same property migration 0027 relied on for the same reason.

-- ---------------------------------------------------------------------------
-- 1. THE AUDIT LOG GAINS THE TWO FACTS THE AGGREGATE IS DERIVED FROM
-- ---------------------------------------------------------------------------
--
-- Added to the log as well as to the aggregate so that the aggregate is
-- REBUILDABLE BY OBSERVATION from any row written after this migration — the
-- same "losing it costs a colder filter and never data" licence
-- `lumen_feed_store` and `lumen_feed_served` both already carry. It costs two
-- nullable columns.
--
-- ★ NULL MUST BE READ AS "UNKNOWN", NEVER AS ZERO. An unknown engager baseline
-- means resurrection CANNOT BE EVALUATED, which the ranker resolves toward
-- SHOWING the post. Reading NULL as 0 would turn "we could not tell" into "it
-- has never been engaged" — the strictest possible reading of the least
-- reliable data, applied to the one decision that can empty a feed.
ALTER TABLE lumen_feed_served
  ADD COLUMN IF NOT EXISTS engagers_at_serve SMALLINT;

-- ★★★ CONTRACT C8 — THE RANKED IDENTITY, BECAUSE `post_key` IS NOT IT.
--
-- `post_key` is the DISPLAY identity, `author/permlink`, no `@`. recsys's
-- `Post.key` is `@author/permlink`, and for a Lumen-native post `author` is the
-- writer's `lumen_user_id` ULID. Those are DIFFERENT STRINGS, so a suppression
-- set built from `post_key` matches ZERO lite posts, forever, with no error.
--
-- PROVEN AGAINST REAL ROWS, 2026-08-15, not inferred from code:
--
--   46 of the 8,508 served rows are Lumen-native, and every one of them is
--   keyed by handle, e.g.
--     bravouyuce/lumen-01kzchxgtzzg4ef6v9kyb694de   (3 impressions, 2 viewers)
--   whose three identities are:
--     recsys Post.key   @01KZAC6C92G3MJ7QV8BN3B82EA/lumen-01kzchxgtzzg4ef6v9kyb694de
--     served post_key   bravouyuce/lumen-01kzchxgtzzg4ef6v9kyb694de
--     chain publisher   hbd-temp
--   and:
--     SELECT count(*) FROM lumen_feed_served WHERE post_key LIKE '@%';  -->  0
--
-- Captured at serve time by `hydrate`'s `postByKey`, which is the ONLY place
-- that holds all three identities at once.
ALTER TABLE lumen_feed_served
  ADD COLUMN IF NOT EXISTS ranked_key TEXT;

-- ---------------------------------------------------------------------------
-- 2. THE AGGREGATE — WHAT THE RANKER ACTUALLY READS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lumen_feed_seen (
  -- Same identity domain as `lumen_feed_served.viewer` and
  -- `lumen_feed_store.viewer`: a Hive account name or a lite handle, matched
  -- EXACTLY. It is also the string recsys receives as `?viewer=`, which is what
  -- makes the ranker's read a plain equality on this column.
  viewer                  TEXT        NOT NULL,

  -- The SERVED identity, `author/permlink` — same domain as
  -- `lumen_feed_served.post_key`. Primary key with `viewer` because that is the
  -- identity the writer has in hand for every entry, including the ones recsys
  -- did not name a lane for.
  post_key                TEXT        NOT NULL,

  -- The RANKED identity, `@author/permlink`. THIS is what suppression joins on.
  -- NULL only when the delivery carried no matching RecsysPost; the reader
  -- repairs a NULL as '@' || post_key, which is exactly right for an ordinary
  -- Hive post and harmlessly wrong for a lite one (it yields a key matching no
  -- candidate, so that post is simply never suppressed — failing toward SHOWING
  -- a post is the safe direction everywhere in this feature).
  ranked_key              TEXT,

  -- Deliveries inside the window. THE number the 2-impression rule consumes.
  impressions             SMALLINT    NOT NULL DEFAULT 0,

  -- ★ Marks the versioning boundary per row. Every row here postdates the probe
  -- fix; see the header.
  first_served_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_served_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- ★★★ DISTINCT NON-LITE ENGAGERS THIS POST CARRIED AT ITS MOST RECENT SERVE.
  -- WITHOUT THIS COLUMN THE RESURRECTION RULE IS UNMEASURABLE — "did it grow"
  -- has no meaning without a baseline to grow FROM.
  --
  -- ★ IT IS OVERWRITTEN ON EVERY SERVE, AND THAT IS THE WHOLE DESIGN. The
  -- baseline is "what it had when I last showed it to you", so each serve
  -- re-arms it at the higher value and a second resurrection costs another full
  -- growth step on top. Impressions keep accruing and are never reset, so a post
  -- that stops growing stays suppressed permanently while one that keeps taking
  -- off keeps coming back, each time at a higher price. No `resurrected_at`
  -- column, no reset bookkeeping, no oscillation.
  --
  -- ★ NULL = UNKNOWN, NEVER 0. See the note on `lumen_feed_served` above.
  engagers_at_last_serve  SMALLINT,

  -- Best (lowest) position this post has ever been delivered at, for analytics.
  best_position           SMALLINT    NOT NULL DEFAULT 0,

  -- ★★★ THE GUARD'S OUTPUT. Set when this viewer's impressions-per-distinct-post
  -- ratio passes the hard bound — i.e. when something that is NOT a reader is
  -- recording. The ranker reads it as "DO NOT SUPPRESS THIS VIEWER".
  --
  -- This exists because the exact failure it catches ALREADY HAPPENED: the
  -- counter read 31-40 impressions per post for six days with nothing anywhere
  -- saying so, and the only reason it was noticed is that somebody went looking.
  -- A counter that has provably lost its meaning must stop being a ranking
  -- input, and degrading to NO SUPPRESSION costs a reader repetition rather than
  -- an empty feed. Cleared by the sweep when the window rolls.
  tainted                 BOOLEAN     NOT NULL DEFAULT false,

  PRIMARY KEY (viewer, post_key)
);

-- The one read the ranker makes: everything this viewer has seen in the window.
CREATE INDEX IF NOT EXISTS lumen_feed_seen_viewer_recent_idx
  ON lumen_feed_seen (viewer, last_served_at DESC);

-- ★ THE TTL CUT IS A GLOBAL TIME PREDICATE AND CANNOT USE THE INDEX ABOVE —
-- that one leads on `viewer`, so a sweep over all viewers would seq-scan. This
-- is what makes the sweep cheap.
CREATE INDEX IF NOT EXISTS lumen_feed_seen_last_idx
  ON lumen_feed_seen (last_served_at);

-- ---------------------------------------------------------------------------
-- THE QUESTIONS THIS TABLE HAS TO BE ABLE TO ANSWER
-- ---------------------------------------------------------------------------
--
-- Per-viewer suppression pressure — run before arming and 7 days after:
--
--   SELECT viewer,
--          count(*) FILTER (WHERE impressions >= 2) AS suppressed_now,
--          count(*)                                 AS seen_in_window,
--          round(sum(impressions)::numeric / NULLIF(count(*), 0), 1) AS impr_per_post,
--          count(*) FILTER (WHERE engagers_at_last_serve IS NULL) AS baseline_unknown,
--          bool_or(tainted)                         AS tainted,
--          max(last_served_at)                      AS last_seen
--     FROM lumen_feed_seen
--    WHERE last_served_at > now() - INTERVAL '7 days'
--    GROUP BY viewer ORDER BY 2 DESC;
--
-- ★ `impr_per_post` IS THE GUARD'S PANEL. It read 31-40 for the three heaviest
-- viewers before the probe fix. Under a rule that suppresses at 2 it cannot
-- legitimately exceed a small handful. If it has not fallen, the instrument is
-- still wrong and NOTHING may be armed on top of it.
--
-- Did suppression actually reduce repetition (the 80% / 16-of-20 baseline
-- measured for `lordbutterfly` at 18:25 vs 23:04 UTC on 2026-08-14)?
--
--   SELECT count(*) AS repeats_in_top_20
--     FROM lumen_feed_served a
--     JOIN lumen_feed_served b USING (viewer, post_key)
--    WHERE a.viewer = $1
--      AND a.served_at > now() - INTERVAL '6 hours'
--      AND b.served_at < a.served_at - INTERVAL '2 hours'
--      AND a.position < 20 AND b.position < 20;
