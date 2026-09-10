-- ★★★ NAME SQUATTING: A LITE HANDLE CAN BE CLAIMED ON HIVE AFTER SIGNUP (2026-09-10).
--
-- Lite signup vets a name against BOTH namespaces and fails closed (auth-service.ts:
-- `findUserByDisplayName` for Lumen, `checkAccountExists` for Hive), so a lite handle
-- is provably free on Hive at the moment it is issued. Nothing re-checks afterwards,
-- and Hive's namespace is open: anyone can register that same name later.
--
-- When they do, every lookup in this app that resolves a NAME to a lite identity
-- (`findUserByDisplayName`) keeps answering with the lite user, so the newcomer's
-- profile, posts, follow graph and moderation state resolve to somebody else's
-- account. Reproduced 2026-09-10 by seeding a lite user named `daveks` (a real Hive
-- account since 2016): `GET /api/lite/posts?author=daveks` returned the lite user's
-- post with `author: "daveks"`.
--
-- These columns are the persistent verdict, written by the sweep rather than derived
-- on every read. That matters for two reasons: the hot paths (avatar, posts, follow)
-- must not make a chain call per request, and a Hive outage must not be able to
-- change who a name resolves to.
--
--   name_conflict_at       when the sweep first saw a Hive account with this name
--                          that is NOT this user's own upgrade. NULL = clean.
--   name_conflict_creator  provenance: the Hive account's `recovery_account`, which
--                          defaults to whoever created it. Ours (the account in
--                          LITE_ACCOUNT_CREATOR_ACCOUNT_*) means it came through our
--                          own upgrade path and is not a squatter. Anything else is.
--                          Changeable by the account owner after a 30-day delay, so
--                          this is strong evidence, not proof -- the definitive check
--                          is the account_create op in its history.
--   name_conflict_created  the Hive account's own creation time, so "registered after
--                          the lite account" is answerable without a second lookup.
ALTER TABLE lumen_user
  ADD COLUMN IF NOT EXISTS name_conflict_at      timestamptz,
  ADD COLUMN IF NOT EXISTS name_conflict_creator text,
  ADD COLUMN IF NOT EXISTS name_conflict_created timestamptz;

-- The sweep pages through unresolved users oldest-first; the resolver reads the flag
-- on the single-row lookup it already does, so it needs no index of its own.
CREATE INDEX IF NOT EXISTS ix_lumen_user_name_conflict
  ON lumen_user (name_conflict_at)
  WHERE name_conflict_at IS NOT NULL;
