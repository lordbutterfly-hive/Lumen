-- 0033_rank_zero.sql — rank 0 has to be storable, and today it is the common case.
--
-- ★★ WITHOUT THIS, EVERY SNAPSHOT WRITE FAILS (owner, 2026-08-09: "no one gets rank 7 off the
-- bat. everyone is rank 0, its based off of activity").
--
-- 0029 created `lumen_hive_rank` with `CHECK (rank_number >= 1 AND rank_number <= 9)`, which was
-- correct when the ladder ran 1..9 and the bottom rung was Spark. The ladder now starts at 0:
-- rank is distinct days of activity Lumen actually observed, inside a trailing year, so every
-- account — including a ten-year Hive veteran on its first request — measures 0 until it does
-- something here.
--
-- `recordRankMark` is called on every successful computation of the chain route. Left as it was,
-- that INSERT would violate the constraint for essentially every account on the platform. It is
-- wrapped in a try/catch and only logs a warning, so the failure mode is not a 500 — it is the
-- byline mark silently never being written for anybody, which is the kind of quiet breakage that
-- survives a whole test suite.
--
-- The upper bound stays at 9. There are ten STATES and nine RANKS: rank 0 is the absence of a
-- rank, not a tenth one, and nothing above Lumen exists.

ALTER TABLE lumen_hive_rank DROP CONSTRAINT IF EXISTS lumen_hive_rank_rank_number_check;
ALTER TABLE lumen_hive_rank
  ADD CONSTRAINT lumen_hive_rank_rank_number_check
  CHECK (rank_number >= 0 AND rank_number <= 9);

-- Existing snapshots were computed by the OLD ladder, off Hive account age and Hive votes — the
-- exact numbers this change exists to stop publishing. They are wrong now, not stale: a stored
-- Aurora 8 would keep rendering a byline mark for an account that has done nothing here, and the
-- batch endpoint reads this table without recomputing. Clearing them means the mark is absent
-- until the per-account route recomputes it honestly, which is the correct default.
DELETE FROM lumen_hive_rank;
