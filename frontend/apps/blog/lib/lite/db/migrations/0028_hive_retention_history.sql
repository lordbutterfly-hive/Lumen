-- 0028 — Persisted retention history for HIVE accounts.
--
-- ═══ WHY THIS EXISTS: THE RANK CURRENTLY TRACKS HOW BUSY A HIVE NODE IS ═══
--
-- `/api/streak/[user]` derives active-weeks and the streak by walking an account's
-- posts and comments feeds BACKWARDS, newest first, under a 20-second wall clock
-- (REQUEST_BUDGET_MS). When the clock wins, the walk stops mid-history and the
-- resulting activeWeeks is a LOWER BOUND, not a measurement. The route is honest
-- about it (`coverage.activeWeeksIsLowerBound`) and the UI renders "at least N",
-- but the RANK is computed from the truncated number all the same.
--
-- Measured live on 2026-08-08, same account, nine minutes apart, nothing about the
-- account changed:
--
--     15:33:56  @acidyo  rung 6   comments walk read 500 items
--     15:42:53  @acidyo  rung 3   comments walk read 260 items
--
-- Three rungs, from node latency. And @hivebuzz — a daily poster since 2018 — is
-- routinely served activeWeeks: 11 out of 26.
--
-- This was survivable only because the reputation proxy usually bound first and hid
-- it. Removing reputation (2026-08-09) makes presence a co-equal driver, so the
-- defect moves from "hidden" to "decides everybody's rank". It is a hard
-- prerequisite for that change, not a follow-up.
--
-- ═══ THE FIX: WALK ONCE, THEN ONLY WALK WHAT IS NEW ═══
--
-- Store the act-day SET per account and extend it incrementally. After the first
-- build a refresh only has to read as far back as `newest_walked`, which for a
-- returning reader is a page or two — so the walk becomes both cheap AND complete,
-- and `activeWeeksIsLowerBound` goes permanently false once `history_complete` is
-- set. Same shape as the fix that solved the "For You" cold-rebuild timeout in
-- migration 0026: build once behind a spinner, then serve from Postgres forever.
--
-- It also makes three of the interesting numbers computable for the first time:
-- longest-ever streak, the weekday pattern, and "who found you this week" — none of
-- which a single truncated walk can answer, because all three are questions about
-- history rather than about the last page of it.
--
-- ═══ IDENTITY ═══
--
-- CITEXT keyed on the Hive account name, matching `lumen_hive_reader_prefs`
-- (migration 0024) — the existing precedent for "a row about a Hive account".
-- Hive names are already lowercase by consensus rule, so case-folding is a
-- convenience here rather than a decision about identity.
--
-- No existing table changes behaviour. One index is added to `lumen_feed_served`.


-- ---------------------------------------------------------------------------
-- 1. The act-day set
-- ---------------------------------------------------------------------------
-- One row per (account, UTC day on which they authored a post or a comment).
--
-- DAYS, not timestamps, and authored acts ONLY. The day grain is what every arm
-- actually consumes (`computeStreak` takes 'YYYY-MM-DD' strings), and it makes the
-- row count bounded by calendar rather than by how prolific someone is: a decade of
-- daily posting is ~3,650 rows, and forty posts in one day is still one.
--
-- Authored acts only, because that is the one currency both ladders can measure
-- symmetrically. A Hive user's votes never touch this server (they broadcast from
-- the browser) and reading them needs account_history_api, which is not registered
-- — but their posts and comments are on chain and this route already reads them. A
-- day set built on votes would be fillable by lite users and unfillable by Hive
-- users doing the same thing, which is an inequity rather than a measurement.
CREATE TABLE IF NOT EXISTS lumen_hive_act_day (
  hive_account CITEXT NOT NULL,
  act_day      DATE   NOT NULL,
  PRIMARY KEY (hive_account, act_day)
);

-- "Give me this account's days, newest first" — the only read shape there is.
CREATE INDEX IF NOT EXISTS lumen_hive_act_day_recent_idx
  ON lumen_hive_act_day (hive_account, act_day DESC);


-- ---------------------------------------------------------------------------
-- 2. The walk cursor — what we have actually read
-- ---------------------------------------------------------------------------
-- ★ THIS TABLE IS THE HONESTY RECORD, AND IT IS THE POINT OF THE MIGRATION.
--
-- An act-day set on its own cannot distinguish "this account did nothing in March"
-- from "we never read March". That distinction is the entire difference between a
-- measurement and a guess, and publishing the second as the first is what demoted
-- @acidyo three rungs. `oldest_walked` is the boundary: days at or after it are
-- KNOWN, days before it are UNREAD, and a gap on either side of that line means
-- completely different things.
CREATE TABLE IF NOT EXISTS lumen_hive_walk_cursor (
  hive_account     CITEXT      PRIMARY KEY,

  -- Oldest UTC day for which BOTH feeds have been read. The act-day set is
  -- complete from here forward and says nothing at all before it.
  oldest_walked    DATE,

  -- Newest UTC day read. An incremental refresh only needs to walk back to here.
  newest_walked    DATE,

  -- The walk reached the account's creation date, so `oldest_walked` is the start
  -- of history and there is nothing older to find. Once true, activeWeeks and the
  -- streak are exact and `activeWeeksIsLowerBound` is false.
  history_complete BOOLEAN     NOT NULL DEFAULT FALSE,

  -- ★ WHEN WE STARTED WATCHING. Required for "N people found you this week" to be
  -- a true sentence: `lumen_hive_giver.first_seen` records when WE first saw a
  -- giver, not when they first engaged. On a freshly built row every giver looks
  -- new, so an account whose history was built today would be told that 1,564
  -- people discovered it this week. The reader must not see that number until we
  -- have genuinely been watching longer than the window it is measured over.
  first_built_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ---------------------------------------------------------------------------
-- 3. Givers seen, for first-time detection
-- ---------------------------------------------------------------------------
-- One row per (author, account that engaged them), with the day WE first observed
-- it. This is what makes the best line in the whole feature possible:
-- "@tarazkp read you for the first time today." Nothing on Hive tells anybody that.
--
-- It stores raw distinct givers, NOT the credited/budgeted count. The credited
-- figure is a SCORE and belongs nowhere near a sentence containing the word
-- "people" — that mistake has already been made once on this feature and shipped
-- "1111 people have engaged with your posts" for an account with 1,564 real voters.
-- The anti-farm budget applies to the ladder arm and to nothing else.
CREATE TABLE IF NOT EXISTS lumen_hive_giver (
  hive_account CITEXT NOT NULL,
  giver        CITEXT NOT NULL,
  first_seen   DATE   NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date,
  PRIMARY KEY (hive_account, giver)
);

-- "Who did I meet recently" — a per-author descending scan on the day.
CREATE INDEX IF NOT EXISTS lumen_hive_giver_recent_idx
  ON lumen_hive_giver (hive_account, first_seen DESC);


-- ---------------------------------------------------------------------------
-- 4. Streak freezes — the Duolingo mercy, finally given a ledger
-- ---------------------------------------------------------------------------
-- `computeStreak` has taken a `freezeAvailable` parameter since it was written, and
-- its own header says why: "A banked freeze bridges one missed day (Duolingo mercy;
-- prevents the churn cliff)." Both call sites passed a hardcoded `0`, because there
-- was nowhere to bank one. This is the nowhere.
--
-- ★ IT IS SERVER-SIDE AND CHAIN-DERIVED, NOT CLIENT STORAGE. A freeze changes the
-- STREAK, and the streak is the one number on this feature that is derived entirely
-- from chain facts so that it cannot be self-inflated. A forgeable freeze would make
-- a forgeable streak, which would quietly move the streak from the measured half of
-- the system to the cosmetic half. Freezes are EARNED from the act-day set above
-- (one per seven active days, at most two held) and every one that gets used records
-- the day it covered.
--
-- ★ WHY SPENT DAYS ARE STORED RATHER THAN A COUNTER. The streak is recomputed from
-- scratch on every read. If a freeze merely decremented a counter, the gap it
-- bridged would still be a gap on the next read — the streak would break the moment
-- the counter ran out, undoing the mercy it had already granted. Storing the DAY
-- makes it idempotent: a covered day is fed back in as covered, and the budget is
-- only ever spent on gaps that are new.
CREATE TABLE IF NOT EXISTS lumen_hive_freeze_spent (
  hive_account CITEXT NOT NULL,
  -- The missed day this freeze covered.
  covered_day  DATE   NOT NULL,
  spent_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (hive_account, covered_day)
);


-- ---------------------------------------------------------------------------
-- 5. Reach: an author-prefix index on the served log
-- ---------------------------------------------------------------------------
-- "Your posts landed in N feeds" is a COUNT(DISTINCT viewer) over
-- `lumen_feed_served` where `post_key` starts with '<author>/'. That column is
-- `author/permlink` and migration 0027 indexed it only by viewer and by time, so
-- the query would scan every impression in the retention window.
--
-- `text_pattern_ops` is required and is not a style choice: the default opclass
-- follows the database collation, and a prefix `LIKE 'author/%'` can only use an
-- index built for pattern matching. Without it Postgres silently ignores the index
-- and sequentially scans the busiest table in the schema.
CREATE INDEX IF NOT EXISTS lumen_feed_served_post_prefix_idx
  ON lumen_feed_served (post_key text_pattern_ops, served_at DESC);
