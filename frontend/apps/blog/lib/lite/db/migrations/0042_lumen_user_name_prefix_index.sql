-- 0042_lumen_user_name_prefix_index.sql — prefix index for the search typeahead / People tab.
--
-- `searchLiteUsersByPrefix` (user-repository.ts) answers "which lite handles start
-- with what the reader typed" with `lower(display_name::text) LIKE $1 || '%'`. The
-- only index on `display_name` is the citext UNIQUE constraint from 0001, which is
-- ordered by the collation and cannot serve a prefix LIKE; without this index every
-- keystroke that reaches the route sequentially scans `lumen_user`.
--
-- `text_pattern_ops` is required and is not a style choice (same rule as 0028 §5):
-- the default opclass follows the database collation, and a prefix `LIKE 'abc%'` can
-- only use an index built for pattern matching. The indexed expression is exactly the
-- one the query uses, `lower(display_name::text)`, so the planner matches it.
-- Idempotent. Must be applied on the box BEFORE the build that ships the query goes
-- live (the query is correct without it, only slow).
CREATE INDEX IF NOT EXISTS ix_lumen_user_display_name_prefix
  ON lumen_user (lower(display_name::text) text_pattern_ops);
