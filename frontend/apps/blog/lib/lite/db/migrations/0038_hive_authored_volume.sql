-- 0038 — how much a Hive account has actually WRITTEN, accumulated the same way its
-- act-days are (owner, 2026-08-18: "maybe how many lines of text they wrote... you have
-- written in 1 year the equivalent of a 100 page book").
--
-- ═══ WHY IT NEEDS A TABLE AND CANNOT JUST BE COMPUTED PER REQUEST ═══
--
-- `/api/streak/[user]` already has the bodies: `bridge.get_account_posts` returns the
-- full markdown of every item both feed walks read, so the words are free at the point
-- of the walk. What is NOT free is the SCOPE. A walk is a newest-first prefix bounded by
-- a 20-second wall clock and a 26-week cutoff, so a per-request count answers "words in
-- the last few months, as far as we got today", which is
--   (a) not what "you have written a book" means, and
--   (b) a number that moves when a public Hive node is slow, which is the exact defect
--       migration 0028 exists to have fixed for the act-day set.
--
-- The owner's standing rule on windowed counts is explicit: "you cant list votes and
-- comments and not have it for all time. if thats the case then drop it." So this
-- accumulates, one row per (account, UTC day), exactly like `lumen_hive_act_day` — every
-- walk contributes what it saw, the union grows toward all-time, and
-- `lumen_hive_walk_cursor.history_complete` says when the union IS all-time. Until then
-- the client renders a floor ("at least"), never a total.
--
-- ═══ WHY `GREATEST` ON CONFLICT, AND WHY THAT MAKES RE-WALKS SAFE ═══
--
-- An incremental walk deliberately re-reads three days of overlap (INCREMENTAL_OVERLAP_MS)
-- because Hivemind indexes with a lag and an edited post can shift in the feed. A `+=`
-- upsert would therefore count those days again on every single visit, and a busy account
-- viewed hourly would "write" a book a week without typing anything.
--
-- The writer sends a per-day TOTAL recomputed from the items that walk saw, and the row
-- keeps the LARGER of the stored and the incoming value. That is idempotent (the same
-- walk writes the same number forever) AND monotone (a deeper walk that catches two more
-- posts on a boundary day raises it, a shallower one cannot lower it). It also means the
-- stored figure is itself a floor per day, which is the direction the whole feature is
-- already honest in.
--
-- ★ THE ONE THING IT WILL NOT DO: a deleted post's words are never subtracted. Judged
-- acceptable rather than overlooked — the words were written, the count is a fact about
-- the author and not an inventory of live content, and the alternative (a per-permlink
-- ledger) is one row per comment for accounts that have hundreds of thousands of them.
--
-- ═══ IDENTITY ═══
--
-- CITEXT on the Hive account name, matching `lumen_hive_act_day` (0028) and
-- `lumen_hive_reader_prefs` (0024). Lite accounts are NOT in here: their words come from
-- `lumen_post.body` in one aggregate (facts-query.ts), which is genuinely all-time and
-- exact because Lumen holds every post they ever wrote.

CREATE TABLE IF NOT EXISTS lumen_hive_authored_volume (
  hive_account CITEXT NOT NULL,
  act_day      DATE   NOT NULL,

  -- Words authored on that UTC day, across posts and comments, as counted by
  -- `features/retention/lib/act-stats.ts:countWords` (code blocks, image markup, raw
  -- URLs and HTML stripped first). A floor per day — see GREATEST above.
  words        INTEGER NOT NULL DEFAULT 0 CHECK (words >= 0),

  PRIMARY KEY (hive_account, act_day)
);

-- The only read shape is "sum this account's words", which the primary key already
-- serves as a prefix scan. No second index: one more index on a table written on every
-- cache miss costs more than the scan it would save.
