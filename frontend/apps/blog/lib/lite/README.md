# Lumen Lite Accounts — build tracker

**Last verified against the code on 2026-07-28.** If a claim here disagrees with the
code, the code wins — say so and fix this file.

A lite account is a chosen name + `user_id`, authenticated by a **Google identity**,
a **Bitcoin wallet**, or an **EVM wallet**, with **no Hive account and no keys**.
Posts land in this Postgres schema; a server-side publisher broadcasts them under
Lumen's own Hive account with a `Posted via Lumen by {name}` footer. Lite posts
**decline all rewards** — a user earns only on their own Hive account, after upgrading.

Full spec: `/mnt/o/LUMEN-DOCS/frontend-lite/LUMEN-LITE-ACCOUNTS-SPEC-2026-07-22.md`
(the docs folder was renamed from `O:/HIVE-BLOG-REBUILD` on 2026-07-27).

Current inventory: **78 TS modules · 31 API routes · 16 migrations** (0001–0004,
0006–0017; `0005_ledger.sql` was deleted with the earnings subsystem).

## Decisions that shape everything here

| Decision | Consequence in the code |
|---|---|
| **No earnings, ever, for a lite post** (2026-07-23) | Posts broadcast with `max_accepted_payout 0.000` and no beneficiary. The whole Phase-6 ledger/accrual/settlement subsystem was **deleted** — there is no money to hold, so no custody question and no money-transmission exposure. |
| **Every lite post is a comment under a rolling container** (2026-07-27) | Hive caps root posts at ~1 per 5 min per account but replies at 1 per 3 s. `publisher/container.ts` opens `lumen-c-<ulid>` roots and rotates at `LITE_CONTAINER_MAX_CHILDREN`. Throughput ≈ 20/min per publishing account. |
| **Votes / reblogs / follows are Lumen-local** | A Hive vote is attributed to the *signing* account, so N lite users would collapse into one vote. They live in `lumen_vote` / `lumen_reblog` / `lumen_follow` and materialise on chain only after upgrade. |
| **Following works across both tiers** (2026-07-28) | Three of the four directions cannot be chain operations — a lite user has no key, and a lite user is not an account that can be followed. `lumen_follow` now holds a Lumen user id OR a Hive name on each side (migration 0017). A Lumen account is always stored by `user_id`, so upgrading costs a user nothing: their audience follows them. Hive→Hive is refused here and stays on chain. |
| **Lite images go to Hive's image host** (2026-07-28) | The host authenticates uploads with a posting-key signature; a lite account has none, so `POST /api/lite/upload` signs with the PUBLISHING account. No storage of our own to run, and the URLs are ordinary public image URLs. Proven end to end against the real host. |
| **Hive is the source of truth for published content** | `pruneBodyAfterPublish` defaults TRUE: after publish the row keeps the mapping, not the body. Rendering a published post = fetch from chain + overlay the lite identity. |

## Phase status (spec §L)

| Phase | Status |
|------|--------|
| 1 Foundation — datastore, identity schema, session tier, signer/observer guards | **built** |
| 2 Auth — Google + BTC + **EVM** login, name-pick + vetting (passkey parked) | **built** |
| 3 Intake + render — `/api/lite/posts`, `lumen_post`, entry adaptation | **built** |
| 3b Client wiring — composer fork, feed strip, attribution overlay, tier-aware avatar | **built** |
| 4 Publisher — outbox queue, container model, pacing, RC pre-flight, live broadcaster | **built; proven on Hive mainnet** |
| 5 Rate limits / anti-Sybil — intake caps, per-IP caps, /64 IPv6 bucketing, Turnstile | **built** |
| ~~6 Earnings~~ | **deleted 2026-07-23** — lite posts decline all rewards |
| 7 Upgrade — ACT claim, **browser-side keygen**, chain reconciliation, `/upgrade` page | **built; needs a creator account + delegated HP before it can run** |
| 8 recsys reconciliation — author/graph resolution for the ranking layer | **built** |
| 9 Moderation — account status, post visibility, takedown, audit trail | **built 2026-07-28** |
| 10 Recovery — linked sign-in methods, second-binder UI, `/security` page | **built 2026-07-28** |

## Module map

```
lib/lite/
  config.ts                    env-derived config (never secrets) + fail-closed assert
  ids.ts  types.ts             crypto ULID/nonce; domain types

  db/                          lazy pg pool, query(), withTransaction(), withAdvisoryLock(),
                               forward-only migration runner + migrations/
  repositories/                one module per table; all SQL lives here

  http/
    session.ts                 App Router iron-session access
    csrf.ts  guard.ts          x-csrf-token; guardWrite/guardRead/guardPublisher/
                               guardModerator/guardRecsys (constant-time tokens)
    actor.ts                   requireActiveLiteUser (adds) vs requireLiteUser (withdraws)
    ip.ts                      client IP from the TRUSTED end of x-forwarded-for; /64 for IPv6

  auth/
    google-verify.ts           OAuth2Client.verifyIdToken — the root of trust
    btc-verify.ts              BIP-137 + BIP-322 via bip322-js; taproot rejected
    btc-key-fingerprint.ts     hash160(pubkey) — one key is one account, not three addresses
    evm-verify.ts              EIP-191 personal_sign, EOA only (EIP-1271 deliberately refused)
    email-crypto.ts            AES-256-GCM envelope (KMS seam) + sha256 hash
    auth-service.ts            resolveLogin / completeSignup / bindMethod
    account-status.ts          is this session still allowed to act? (DB, not cookie)

  upgrade/
    account-creator.ts         ACT claim + keygen seam (setAccountCreator injection)
    upgrade-service.ts         creates the account, but writes the encrypted keys FIRST

  social/
    follow-actor.ts            who is on each end of an edge: a Lumen user id or a Hive
                               name; canonicalises a name to its user id (injection seam
                               for the chain existence check)
    follow-service.ts          follow / unfollow / state for whichever tier each side is

  media/
    image-host.ts              ImageUploader seam + type/size validation
    hive-image-uploader.ts     signs sha256("ImageSigningChallenge"||bytes) with the
                               publishing account's posting key, POSTs to the image host

  profile/profile-service.ts   validation for the editable lite profile; drops anything
                               that is not an ordinary http(s) URL (stored-XSS surface)

  names/vetting.ts             format + reserved (substring) + wallet-shape + live existence
  antispam/                    windows, trust tiers, rate limits, Turnstile

  content/
    pre-screen.ts              structural checks only — the abuse classifier is still a SEAM
    post-service.ts            create/edit/delete intake, container reservation, orphan repair
  moderation/
    moderation-service.ts      suspend/ban/reinstate, post visibility, takedown, audit log

  publisher/
    broadcaster.ts             PostBroadcaster interface + setBroadcaster (injection point)
    hive-broadcaster.ts        the real signer; runtime-imports wax/beekeeper (see next.config.js)
    container.ts  pace.ts      rolling container posts; ONE shared 3-second pacer
    permlink.ts  footer.ts     postId-derived permlink (stable across edits); footer + metadata
    rc-guard.ts                resource-credit pre-flight, fails OPEN on a node hiccup
    worker.ts  run-worker.ts   claim → build → broadcast → write back the mapping

  render/                      db-post-to-entry, lite-entry (chain + identity overlay),
                               lite-account, lite-identity, lite-post-id
  client/                      lite-write (posts/follow), lite-engagement (READ side of
                               Lumen-local votes/reblogs), lite-security (linked
                               methods + binding), lite-post-fetch
  recsys/resolver.ts           author/graph resolution for the ranking layer
  wallet/did-pkh.ts            wallet DID derivation
```

## API surface

```
auth      /api/lite/auth/{google, btc/challenge, btc/verify, evm/challenge, evm/verify,
                          name, bind, stepup, methods, logout}
names     /api/lite/name/check
content   /api/lite/posts (POST create/edit, GET feed) · /api/lite/posts/[id] (GET, DELETE)
social    /api/lite/{vote, reblog, follow, unfollow} · /api/lite/engagement (GET, read side)
          /api/lite/follow/state (GET — does the viewer follow them ON LUMEN, and is
                                  Lumen where that follow belongs at all?)
profile   /api/lite/profile (GET, POST) · /api/lite/upload (POST, multipart image)
publisher /api/lite/publisher/{drain, health}   (x-lite-publisher-token)
moderation/api/lite/moderation/{user, post, actions}   (x-lite-moderator-token)
recsys    /api/lite/recsys/{resolve, follow-edges}     (x-lite-recsys-token)
wallet    /api/lite/wallet/dids
upgrade   /api/account/upgrade (GET status + reconcile, POST create with PUBLIC keys only)
```

## Moderation (Phase 9)

`lumen_user.status` and `lumen_post.feed_visibility` accepted moderation values from
migration 0001/0002 onward and **nothing ever wrote them** — the model existed on
paper. What exists now:

- `POST /api/lite/moderation/user` — suspend / ban / reinstate, optionally hiding all
  their content. Suspension **parks** queued publish jobs (`publish_job.status =
  'holding'`) rather than cancelling them, so reinstating is a true undo.
- `POST /api/lite/moderation/post` — set visibility; `takedown: true` additionally
  queues the on-chain removal.
- `GET /api/lite/moderation/actions` — the append-only trail (who, what, why, and what
  it actually did).
- Enforcement: `auth/account-status.ts` is consulted on every path that ADDS
  something — posting, editing, voting, reblogging, following, **and upgrading**
  (an upgrade would otherwise burn one of our ACTs and hand a banned user a full
  account we can never moderate). Withdrawals — unfollow, un-reblog, clearing a vote,
  deleting your own post — stay open on purpose.
- A moderator-hidden post refuses further edits, or the author could push an `update`
  job and restore the content on chain.

Two honest limits, said out loud in the API responses: **Lumen can hide, Hive cannot
forget** (a hide does nothing to a post already broadcast), and Hive refuses a real
`delete_comment` once a post has replies or net-positive votes — the worker blanks
the content instead.

Operator tool: `scripts/lite-moderate.mjs` (there is no admin UI and no admin account
model; the endpoints hold a shared secret and every action records the `--actor`
label you pass).

## Running it locally

```bash
docker start lumen-pg                     # postgres:16 on :5433, data is ephemeral
cd apps/blog && npx tsx lib/lite/db/run-migrations.ts
cd ~/hive-blog-rebuild && set -a && . ./.env.blog && set +a && pnpm dev:blog
```

`LITE_*` vars **must** live in `apps/blog/.env.local` — turbo's strict env mode strips
undeclared vars from the sourced `.env.blog`, so they never reach the server. Template:
`apps/blog/.env.lite.example`.

End-to-end scripts (`scripts/lite-*-e2e.mjs`) run against a local server and prove the
BTC login, EVM login, edit/delete, moderation, Lumen-local engagement read-back, and
account-recovery binding paths. **None of them call `/api/lite/publisher/drain` — that
broadcasts to Hive mainnet.**

`scripts/lite-upgrade-e2e.ts` is the exception in shape: it imports the upgrade
service directly and runs against the real Postgres with a stubbed `AccountCreator`,
because the real one burns an account-creation token and writes to chain. Run it with
`cd apps/blog && npx tsx ../../scripts/lite-upgrade-e2e.ts`. Most of its cases are
failures — a lost response, an ambiguous broadcast, a missing encryption key — since
that is the entire reason the outbox exists.

## Recovery (Phase 10)

A lite account has no password and no recovery email — the linked credentials ARE the
account. `/api/lite/auth/{stepup,bind}` could link a second one since Phase 2 and
nothing in the product ever called them, so every user was one lost wallet away from
losing everything, silently. `/security` is that screen: it lists what is linked, says
plainly when only one thing is, and links another wallet or a Google account.

Linking is a step-up — a single-use, user-bound nonce, then a fresh proof of the NEW
credential (SEQ-1/XC-2). **BTC and EVM sign different bind messages**, and `/stepup`
used to return only the Bitcoin one, so an EVM bind could not be completed at all: the
signature verified against the wrong string and came back `bad_signature` with nothing
to say why. It now returns `messages.{btc,evm}` and the caller picks.

`GET /api/lite/auth/methods` deliberately never returns a full `externalRef` — a Google
`sub` and a wallet address are both linkable identifiers, and a truncated hint is enough
to tell two bound wallets apart.

## Still open

1. **The publisher scheduler must actually be deployed.** Two artifacts exist —
   `docker/lumen-publisher.yml` (a service beside the blog) and
   `scripts/lite-publisher-cron.sh` (cron/systemd) — but *choosing and running one is a
   deploy step nobody has taken yet*. `LITE_PUBLISHER_TOKEN` must be set for either.
   `GET /api/lite/publisher/health` now makes the failure observable rather than silent:
   it returns 503 when the oldest pending job ages past the stall window, and the cron
   script exits non-zero on it. Queue depth alone could never tell a draining queue from
   a dead one — the ages do.
2. **Account creation has never broadcast a transaction.** The creator is built and
   wired (`upgrade/hive-account-creator.ts`, installed lazily by both upgrade routes),
   but it stays dark until the operator supplies a creator account name and delegates
   Hive Power (or RC) to it — creation tokens are per-account and cannot be transferred.
   The claim that still needs a testnet: **the master password we mint actually opens
   the account we create**.
3. **`content/pre-screen.ts` is a length check, not a classifier.** The CSAM/abuse
   screen is still a seam; moderation is entirely reactive until it is filled.
4. No lite notifications.
5. WebAuthn passkey is parked; the only implementation is in
   `/mnt/o/LUMEN-DOCS/_salvage/lite-auth-passkey/` (Drizzle-based, does not match the
   raw-`pg` repository pattern here).
6. Lumen-local vote/reblog **totals** are returned by `/api/lite/engagement`
   (`voteCount`/`reblogCount`) but are not yet folded into a post's displayed count —
   the user's own state persists correctly, the aggregate still shows chain-only.

## Deploy notes

- Postgres at `LITE_DATABASE_URL` (the migration creates `citext`).
- **No key-custody configuration, by design.** A new account's keys are generated in
  the user's browser and only the four public keys reach the server, so there is no
  ciphertext to store, no TTL and no encryption key to deploy.
- The publishing Hive account name per network via
  `LITE_FRONTEND_ACCOUNT_{MAINNET,MIRRORNET,TESTNET}`; its keys belong in KMS and are
  injected through `setBroadcaster` — `LITE_PUBLISHER_POSTING_WIF` is a dev-only path
  and the bootstrap refuses it in production.
- The feature stays dark until `LITE_ACCOUNTS_ENABLED=yes`, and `assertLiteEnabled()`
  refuses to open public signup in production without `LITE_TURNSTILE_SECRET`.
- `next.config.js` must **not** list `@hiveio/beekeeper` or `@hiveio/wax` in
  `serverComponentsExternalPackages` — it returns 500 on every page of the app. The
  publisher runtime-imports them instead; the config carries the warning.
- `output: 'standalone'` traces static imports only, so those runtime-imported packages
  may need `experimental.outputFileTracingIncludes` for the drain route.
