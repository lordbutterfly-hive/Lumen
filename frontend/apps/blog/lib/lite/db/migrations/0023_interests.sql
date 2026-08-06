-- 0023_interests.sql — the signup interest picks for a lite account.
--
-- ★ WHY THIS EXISTS. `build_feed` in recsys has accepted `explicit_interest_tags`
-- since it was written, and its own docstring records that the field "existed on
-- build_viewer_profile and was never once passed by production code, so a
-- brand-new account's picks could not reach the ranker and it fell through to
-- popular-fallback padding."
--
-- That was still true on 2026-08-06, and measured: every result for a fresh lite
-- viewer came back `popular_fallback`. Not a wiring bug — a lite account reached
-- the ranker with NO follows, NO interests and NO history, because Lumen never
-- collected an interest anywhere. The personalisation engine had nothing to
-- personalise on for its primary audience.
--
-- One JSONB array rather than a join table, matching `profile` (0016) directly
-- above: the picks are read and written WHOLE, on signup and on edit, and are
-- never queried by individual element. A join table would buy a query shape
-- nothing performs.
--
-- `interests_set_at` is separate from "is the array non-empty" on purpose: it
-- distinguishes "has not been asked yet" (NULL -> show the picker) from "was
-- asked and chose to skip" (set, array empty -> never nag again). Collapsing
-- those two would re-prompt forever anyone who declined.
ALTER TABLE lumen_user
  ADD COLUMN IF NOT EXISTS interests JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE lumen_user
  ADD COLUMN IF NOT EXISTS interests_set_at TIMESTAMPTZ;
