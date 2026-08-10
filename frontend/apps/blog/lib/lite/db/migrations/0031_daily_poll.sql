-- 0031_daily_poll.sql — QUESTION OF THE DAY, and what the community decided.
--
-- ★★ THE IDEA (owner, 2026-08-09): "maybe we can collect the answers and then present on
-- right section question of the day... today the Lumen community decided that no pineaple on
-- pizza. what ever."
--
-- This is a different mechanic from everything else in the retention feature and it is the
-- only one that is genuinely SOCIAL. The rest of the system tells you facts about yourself,
-- which two UX passes independently found correct and inert — "a beautifully typeset
-- scoreboard", "I'd post here and never open my own numbers". A verdict the whole platform
-- reached together is the one thing here that is about other people, and it is the only piece
-- with a natural reason to come back: today's tally is not yesterday's.
--
-- ★ WHY A TABLE AND NOT CLIENT STORAGE. The payload IS the aggregate. A poll whose results
-- live in your own browser can only ever tell you what you already answered, which is the
-- least interesting number in the system. One row per person per day, counted server-side.
--
-- ★ WHY IT IS DELIBERATELY NOT PART OF THE LADDER. Answering a poll must never move a rank,
-- a streak or the daily goal. It is one tap and it is unverifiable — exactly the shape of the
-- forgeable "habit layer" that was correctly deleted from this feature on 2026-08-08. Keeping
-- it decorative is what lets it be fun: nothing is at stake, so nobody has a reason to farm
-- it, and no anti-farm machinery is needed. `lumen_hive_act_day` and this table never meet.

CREATE TABLE IF NOT EXISTS lumen_daily_poll_vote (
  -- The UTC day the question belongs to. The whole platform gets the same question on the
  -- same day, so this is the question's identity as well as its date.
  day          DATE NOT NULL,
  -- Which question was asked. Stored rather than derived, because the rotation is code and
  -- code changes: without this, editing the question catalogue would silently re-label every
  -- historical tally. A day's votes must stay attached to the question that was actually on
  -- screen.
  question_id  TEXT NOT NULL,
  -- The voter. A Hive account name OR a Lumen user id, exactly like
  -- `lumen_retention_goal.account` and `lumen_feed_store.viewer` — one key domain, both
  -- tiers, and a lite account that upgrades keeps its history because the id survives.
  account      TEXT NOT NULL,
  -- 0-based index into the question's option list.
  option_index SMALLINT NOT NULL CHECK (option_index >= 0 AND option_index < 8),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- ★ ONE VOTE PER PERSON PER DAY, enforced by the key rather than by a route check. The
  -- tally is the entire point of the feature, so "can I vote twice" cannot be left to
  -- application logic that a retry, a double-tap or a second tab could get past.
  PRIMARY KEY (day, account)
);

-- The only read this feature makes: "tally today's votes by option".
CREATE INDEX IF NOT EXISTS lumen_daily_poll_tally_idx
  ON lumen_daily_poll_vote (day, option_index);
