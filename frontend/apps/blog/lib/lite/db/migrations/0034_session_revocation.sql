-- 0034_session_revocation.sql — revoke ONE device without signing out the account.
--
-- 0021 gave lite sessions their only revocation lever: `lumen_user.session_epoch`,
-- a per-USER counter stamped into the cookie and re-read on every acting request.
-- It is the right tool for "sign out everywhere" and the wrong one for "sign out",
-- because the product's sign-out is per-DEVICE — `use-sign-out.tsx` routes every
-- lite sign-out to /api/lite/auth/logout, which bumped the counter. So signing out
-- in one tab silently signed the user out of every other tab, phone and laptop.
-- That is the long-standing "epoch drift": 17 of 209 accounts sit above epoch 0,
-- and an earlier attempt to enforce the epoch on /api/users/me had to be reverted
-- because users were being signed out "on almost every action". This is why.
--
-- The missing piece was a per-device identity. Every session issued from now on
-- carries a random `sessionId` in its cookie (auth-service.issueSession); signing
-- out records that one id here, and every acting request refuses a cookie whose id
-- is listed. The account-wide epoch is left alone and keeps its original job:
-- logout-all, suspend/ban and upgrade.
--
-- WHY A DENY-LIST AND NOT A REGISTRY OF LIVE SESSIONS. An allow-list would mean a
-- login that failed to write a row, or any pruning mistake, signs a user out — the
-- exact failure this codebase has already shipped twice and had to revert. A
-- deny-list fails the other way, and its window is bounded by the cookie's own
-- life: iron-session refuses a seal older than the 14-day TTL, so a revocation may
-- be forgotten once the cookie it revokes can no longer be presented. The prune
-- below is set well past that, and revocation writes happen on the logout request
-- itself — if the write throws, the route reports failure rather than claiming a
-- sign-out that did not happen.
--
-- Rows are tiny and short-lived: one per explicit device sign-out, pruned after 30
-- days. Cookies issued BEFORE this build carry no `sessionId`; they are unaffected
-- (the check is skipped for them and their sign-out still falls back to the epoch
-- bump), so deploying this signs nobody out.
CREATE TABLE IF NOT EXISTS lumen_revoked_session (
  session_id TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES lumen_user(user_id) ON DELETE CASCADE,
  revoked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The prune sweep's index. The lookup on the hot path is the primary key.
CREATE INDEX IF NOT EXISTS lumen_revoked_session_revoked_at_idx
  ON lumen_revoked_session (revoked_at);
