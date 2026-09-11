-- ★★★ THE SWEEP RE-READ THE SAME 500 ROWS FOREVER (2026-09-11).
--
-- `listNamesForConflictSweep` selected `WHERE name_conflict_at IS NULL ORDER BY
-- created_at ASC LIMIT 500`, and a row leaves that set ONLY by being flagged
-- (`markNameConflict`, which fires only when a Hive account of that name is FOUND)
-- or by upgrading. A lite account nobody has squatted is therefore never marked, so
-- it stays in the candidate set permanently -- and being oldest, it permanently wins
-- the `created_at ASC` ordering.
--
-- The consequence: once more than LIMIT never-squatted lite accounts exist, the sweep
-- rechecks that same oldest page every 60s forever and every account created after
-- it is NEVER checked. Unflagged means `isSquatterName` answers false, which means
-- the profile layout takes the Hive branch, which means the squatter inherits the
-- victim's URL -- the exact bug the sweep exists to prevent, silently reintroduced
-- for everyone past the ceiling.
--
-- 0043's own comment already described the intent correctly ("the sweep pages through
-- unresolved users oldest-first"); there was simply no column to page WITH. This is
-- that column. `NULLS FIRST` ordering on it makes a never-checked row sort ahead of
-- every checked one, so a new account is picked up on the next tick rather than
-- queueing behind the whole table, and the sweep becomes a true round-robin drain.
ALTER TABLE lumen_user
  ADD COLUMN IF NOT EXISTS name_conflict_checked_at timestamptz;

-- Matches the sweep's selection exactly: the partial predicate keeps the index to the
-- candidate set (unflagged lite rows), and the column order matches ORDER BY.
CREATE INDEX IF NOT EXISTS ix_lumen_user_conflict_sweep
  ON lumen_user (name_conflict_checked_at NULLS FIRST, created_at)
  WHERE name_conflict_at IS NULL AND hive_account_name IS NULL AND account_tier = 'lite';
