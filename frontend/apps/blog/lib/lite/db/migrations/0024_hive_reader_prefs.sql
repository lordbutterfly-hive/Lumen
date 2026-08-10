-- A HIVE ACCOUNT IS A READER TOO.
--
-- 0023 gave lite accounts interests and wired them into the ranker. Measured
-- 2026-08-08 against the running build: a full Hive account got
-- `eligible: false` from /api/lite/interests, so the picker NEVER appeared for
-- them, and `/api/feed/for-you` skipped the whole interests lookup because it
-- was gated on `isLite`. Someone signing in with their existing Hive account —
-- the audience with the most to bring and the least patience — was ranked with
-- no interests at all. The engine was fine; the product only ever asked half
-- its readers.
--
-- Why a separate table rather than a `lumen_user` row per Hive account:
-- `lumen_user` is the LITE identity registry. Its `display_name` is globally
-- unique and a CHECK constraint forbids it from equalling `hive_account_name`,
-- so minting a row for a pure Hive reader would have to invent a Lumen handle
-- for someone who never asked for one, and would burn that handle in the
-- namespace forever. A Hive reader has no Lumen identity — only preferences.
--
-- Mirrors 0023's shape deliberately, including the two-field "asked vs chose"
-- distinction: `interests_set_at` NULL means never asked; set with an empty
-- array means asked and skipped, so we never nag again.
CREATE TABLE IF NOT EXISTS lumen_hive_reader_prefs (
  hive_account     CITEXT PRIMARY KEY,
  interests        JSONB NOT NULL DEFAULT '[]'::jsonb,
  interests_set_at TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
