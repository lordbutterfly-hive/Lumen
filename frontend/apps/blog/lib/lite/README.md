# Lumen Lite Accounts — build tracker

Proxy-posting lite accounts: a chosen name + `user_id` authenticated by Google
passkey **or** BTC wallet, with **no Hive account/keys**. Posts go to this DB and
a server-side publisher broadcasts them under Lumen's own Hive account with a
`Posted via Lumen by {name}` footer. Full spec:
`/mnt/o/HIVE-BLOG-REBUILD/LUMEN-LITE-ACCOUNTS-SPEC-2026-07-22.md`.

## Phase status

| Phase | §L | Status |
|------|----|--------|
| 1 Foundation — datastore, identity schema, session tier, signer/observer guards | 1 | **BUILT + tsc-verified** |
| 2 Auth — Google + BTC login (passkey deferred), name-pick + vetting | 2 | **BUILT + tsc-verified** |
| 3 Intake + render — `/api/lite/posts`, `lumen_post`, `dbPostToEntry`, attribution overlay | 3 | **backend BUILT + tsc-verified; client wiring (3b) next** |
| 4 Publisher — `publish_job` queue, permlink, footer, worker (KMS signer seam) | 4 | **backend BUILT + tsc-verified; RC allocator + moderation-hold gate later** |
| 5 Rate limits — per-account intake caps, trust tiers, anti-Sybil | 5 | **BUILT + tsc-verified** |
| 6 Earnings — accrual worker, ledger, insolvency guard, claim worker, settlement, reconciliation | 6 | **BUILT + tsc-verified** |
| 7 Upgrade — ACT claim, keygen/custody, Sentry scrub fix, settlement | 7 | **BUILT + tsc-verified (scrub fix proven)** |
| 8 recsys reconciliation — `resolve_author` | 8 | **BUILT + tsc-verified** |

> **All 8 §L backend phases built + tsc-verified (2026-07-22).** 53 TS modules · 14 API routes · 7 migrations · ~3,400 LOC. Remaining: **Phase 3b client wiring** (deferred for review — edits in-flight UI) and the **infra seams** (Postgres/Redis/KMS, the real `lumen.posts` account + wax signers, Google client id, Turnstile) which the deploy provides.

## What Phase 1 provides

```
lib/lite/
  config.ts                     feature config from env (no secrets)
  ids.ts                        crypto ULID + challenge nonce
  types.ts                      domain types (camelCase)
  db/
    pool.ts                     lazy pg Pool + query() + withTransaction()
    migrate.ts                  forward-only SQL migration runner
    run-migrations.ts           ops entrypoint (tsx)
    migrations/0001_identity.sql lumen_user, lumen_auth_credential, lumen_challenge, name_reservation
  repositories/                 user / credential / challenge / name-reservation
  session/lite-session.ts       buildLiteSessionUser(), isLiteUser()
```

Guards applied outside this module (existing files):
- `packages/smart-signer/types/common.ts` — `User` gains optional `userId` + `account_tier` (non-breaking).
- `packages/smart-signer/lib/use-signer.ts` — surfaces `accountTier`.
- `packages/smart-signer/components/signer-provider.tsx` — lite early-return before `getSigner()` (must-fix).
- `apps/blog/lib/auth-utils.ts` — `getObserver()` never returns a lite `display_name` as the bridge observer (must-fix).

## What Phase 2 provides

```
lib/lite/
  http/{session,csrf,guard}.ts    App Router iron-session, x-csrf-token, enabled+CSRF guards
  auth/
    google-verify.ts              OAuth2Client.verifyIdToken (root of trust)
    btc-verify.ts                 BIP-137 + BIP-322 (bip322-js); taproot rejected; loginMessage(nonce)
    email-crypto.ts               AES-256-GCM envelope (KMS seam) + sha256 email hash
    auth-service.ts               resolveLogin / completeSignup / bindMethod
  names/vetting.ts                format+reserved+wallet-shape + live-existence (fail-closed)
app/api/lite/
  auth/google/route.ts            POST { idToken }
  auth/btc/challenge/route.ts     POST { address } -> { nonce, message }
  auth/btc/verify/route.ts        POST { address, signature, nonce }
  auth/name/route.ts              POST { displayName }  (completes signup)
  auth/bind/route.ts              POST link 2nd method (google|btc) = recovery
  auth/logout/route.ts            POST destroy session
  name/check/route.ts             GET  ?name= availability (read-only)
```

Session-type change: `IronSessionData` gains a short-lived `liteSignup` pending state (`packages/smart-signer/types/common.ts`). **Deferred:** the WebAuthn passkey layer — until it lands, posting rests on session + CSRF only (the XSS-forgery gap, spec §I).

## What Phase 3 provides (backend)

```
lib/lite/
  db/migrations/0002_content.sql  lumen_post (system of record)
  repositories/post-repository.ts create/get/list (keyset), edit-fork update, softDelete, resolveByHive
  content/pre-screen.ts           fast intake screen (CSAM/abuse classifier seam)
  content/post-service.ts         createLitePost (normal auto-title / advanced), edit fork; feed/timeline reads
  render/db-post-to-entry.ts      LumenPost -> bridge Entry (renders as the user, pre-publish)
  render/attribution.ts           resolveLiteAuthor + rewriteProxyEntry (post-publish overlay)
app/api/lite/
  posts/route.ts                  POST create (normal/advanced, identity from session), GET feed
  posts/[id]/route.ts             GET single post
```

**Phase 3b (client wiring) — DEFERRED for review** (edits in-flight UI: `short-form-composer` / `use-post-form-actions` fork on `account_tier`; attribution overlay in `MediumPostCard`; account-tier-aware `/api/avatar`; DB-feed hook).

## What Phase 4 provides (backend)

```
lib/lite/
  db/migrations/0003_publisher.sql   publish_job outbox queue
  repositories/publish-job-repository.ts  enqueue (idempotent), claimNext (SKIP LOCKED), reschedule/backoff, updatePendingPayload
  publisher/permlink.ts              deterministic postId-derived permlink (stable across edits)
  publisher/footer.ts                "Posted via Lumen by {name}" footer + json_metadata
  publisher/broadcaster.ts           PostBroadcaster interface + setBroadcaster (KMS/wax seam); dark until injected
  publisher/worker.ts                claim -> build op -> broadcast -> writeback mapping; crash-guard; retriable/terminal backoff
  publisher/run-worker.ts            long-lived ops entrypoint
  content/post-service.ts            enqueue-on-post wired (create + edit-before/after-publish)
```

**Storage model (refined with user, 2026-07-22):** the DB is the **outbox + a rebuildable read-cache**; **Hive is the source of truth for published content**. The publish queue is unavoidable because Hive hard-limits ~1 root post / 5 min per account (must queue + shard). After publish, the worker writes only the mapping and can prune the body (`LITE_PRUNE_BODY_AFTER_PUBLISH=yes`). Post-publish rendering = chain entry + `render/attribution.ts` overlay.

**Infra seam:** the real `SignerServerWif` (KMS-held posting key + `@hiveio/beekeeper`/`wax` Node signing) is injected via `setBroadcaster`; the worker stays idle until then.

## What Phase 5 provides (anti-Sybil)

```
lib/lite/
  db/migrations/0004_rate_limits.sql   rate_counter (shared fixed-window store)
  repositories/rate-limit-repository.ts  atomic checkAndConsume, currentCount, cleanup
  antispam/windows.ts                  day/hour window keys + account age
  antispam/trust.ts                    T0(5/15/30) -> T1(10/40/100) -> T2(20/80/300) by trust_score + age
  antispam/rate-limit.ts               enforcePostRate(user, post|comment), enforceSignupRate(ip)
  antispam/captcha.ts                  Cloudflare Turnstile verify (pass-through until configured)
  http/ip.ts                           client IP from x-forwarded-for
```
Wired: post/comment intake -> 429 on cap (edits exempt); signup -> CAPTCHA (403) + per-IP cap (429). Two independent limiters (per-account intake + per-IP signup). The ranking-discount teeth for low-trust posts live in the discovery layer (recsys), not here.

## What Phase 6 provides (earnings)

```
lib/lite/
  db/migrations/0005_ledger.sql   ledger_entry (append-only double-entry) + user_balance + settlement_batch + payout_target + platform_fee_config + accrual_state
  earnings/money.ts               Big.js integer math (never floats); asset precision; bps
  earnings/fee.ts                 platform-fee split (rounding favours user)
  earnings/insolvency.ts          Σ owed <= balance - reserve; fail-closed; FrontendBalanceSource seam
  earnings/accrual.ts             reward-history -> resolve permlink -> book entries; unattributed alerted; watermark; RewardHistorySource seam
  earnings/claim.ts               drains reward pool (account-level); RewardClaimer seam
  earnings/settlement.ts          sweep to Hive account on upgrade; insolvency-gated; debit after transfer; Settler seam
  earnings/reconciliation.ts      rebuild gross from chain, diff vs ledger (anti-insider-theft); LedgerAuditSource seam
  repositories/{ledger,balance,accrual-state,settlement}-repository.ts
```
Money is integer + Big.js end to end; ledger append is idempotent (unique per permlink/type/asset). Seams: reward-history read, reward claim (posting), settlement transfer (active), frontend-balance read, full-history audit. HP/VESTS settlement (power-up) deferred to the upgrade wiring.

## What Phase 7 provides (lite -> full upgrade)

```
lib/lite/
  db/migrations/0006_upgrade.sql   upgrade_event audit
  upgrade/account-creator.ts       ACT claim + keygen + create_claimed_account seam (active-key tier)
  upgrade/upgrade-service.ts       idempotent, chain-reconciled, re-vet new name (≠ handle), settle sweep, reveal-once keys
  upgrade/act-claim.ts             keep an ACT pool ready
  repositories/upgrade-event-repository.ts
app/api/account/upgrade/route.ts   POST { newName }
packages/ui/lib/sentry-scrub.ts    ★must-fix: P?5[HJK]... now redacts MASTER PASSWORDS (was leaking owner keys)
packages/ui/lib/sentry-scrub.selftest.ts   runnable regression (proven: master pw redacted)
apps/blog/lib/lite/repositories/user-repository.ts::markUpgraded  idempotent tier flip; user_id stable (history continuity)
```
`user_id` never changes -> Lumen history stays continuous across the on-chain author change. Keys returned ONCE (reveal-once), never stored/logged. Settlement sweep reuses §G. Custody A (passkey) / B (Google-Drive) are deferred; C (reveal-once) is the built default.

## What Phase 8 provides (recsys reconciliation)

```
lib/lite/
  db/migrations/0007_social.sql   lumen_follow (off-chain follow graph, seq cursor)
  repositories/follow-repository.ts  follow/unfollow/counts/listEdges
  recsys/resolver.ts              resolveAuthors((frontend,permlink)->user), resolveHiveAccounts(name->user), listFollowEdges
app/api/lite/
  recsys/resolve/route.ts         POST batch resolver (token-guarded, constant-time)
  recsys/follow-edges/route.ts    GET follow graph (cursor-paginated)
  follow/route.ts + unfollow/route.ts   POST (session; rate-limited)
```
Recsys substitutes `user_id` for `author` at post_index/graph_cred/second_degree using these — so lite engagement no longer collapses onto `lumen.posts`. Token via `x-lite-recsys-token` (`LITE_RECSYS_TOKEN`), compared constant-time.

## Infra the deploy must provide (NOT in code)

- **Postgres** reachable at `LITE_DATABASE_URL` (needs the `citext` extension; the migration creates it).
- The public frontend Hive account name per network (`LITE_FRONTEND_ACCOUNT_{MAINNET,MIRRORNET,TESTNET}`). Its keys go in KMS (Phase 4), never in env/repo.
- Feature stays dark until `LITE_ACCOUNTS_ENABLED=yes`.

### Env vars (Phase 1)

| Var | Purpose |
|-----|---------|
| `LITE_ACCOUNTS_ENABLED` | `yes` to enable; anything else keeps the feature off |
| `LITE_DATABASE_URL` | Postgres connection string |
| `LITE_DB_POOL_MAX` | pool size (default 10) |
| `LITE_GOOGLE_CLIENT_ID` | Google OAuth client id — audience for ID-token verification (Phase 2) |
| `LITE_EMAIL_ENCRYPTION_KEY` | base64 32-byte AES key for email-at-rest (KMS seam; hash still works without it) |
| `LITE_FRONTEND_ACCOUNT_MAINNET` / `_MIRRORNET` / `_TESTNET` | public on-chain author account name |
| `LITE_TURNSTILE_SECRET` | Cloudflare Turnstile secret for signup CAPTCHA (empty = disabled) |
| `LITE_SIGNUP_PER_IP_PER_DAY` | per-IP signup cap (default 20) |
| `LITE_PRUNE_BODY_AFTER_PUBLISH` | `yes` to drop the stored body after publish (Hive = source of truth) |
| `LITE_PLATFORM_FEE_BPS` | platform fee in basis points from author rewards (0-500, §K decision; default 0) |
| `LITE_OPERATING_RESERVE` | reserve (smallest units) kept above Σ owed for the insolvency guard |

### Apply the schema

```bash
cd apps/blog
LITE_DATABASE_URL=postgres://… pnpm --filter @hive/blog exec tsx lib/lite/db/run-migrations.ts
```

## Open Phase-1 decision (flagged for review)

- `buildLiteSessionUser` sets a **placeholder `loginType`** (`wif`) because the flat
  `User` type requires the field but lite accounts have no `LoginType`. It is never
  read (all signer paths gate on `account_tier` first) and is chosen to fail closed.
  If a dedicated non-signing sentinel is preferred, revisit here + the guards.
