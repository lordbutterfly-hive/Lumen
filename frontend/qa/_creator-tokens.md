# Creator tokens — shared context (2026-08-20)

Read this **in addition to** `_system.md`, `_honesty.md`, `_browser.md`, `_report.md`.
Everything below was verified on chain by the coordinator today, immediately before you started.

★ **REWRITTEN 2026-08-20.** The previous version said "no browser can sign" and named
ONE market. Both are now false and would have sent you hunting the wrong things.

## What is actually deployed

| | |
|---|---|
| contract id | `vsc1BcaD8JrwJPAAN5cU1cHKCBdZrd7jz2WGt8` |
| network | Magi **testnet** (`vsc-testnet`) |
| GraphQL | `https://magi-test.techcoderx.com/api/v1/graphql` |
| owner | `hive:magi.contracts` |
| code CID | `bafkreic2nphgjnwte32nkwix7bga2hjcwx5hfo6n5xrgllczpt7ldfu4pi` |

## Twelve markets exist, not one

Ten Hive-account creators, live, each with two offerings and supply 31:
`lumen.aria` `lumen.beat` `lumen.cole` `lumen.dana` `lumen.echo`
`lumen.finn` `lumen.gray` `lumen.hana` `lumen.iris` `lumen.jude`

Plus a market owned by a WALLET identity, which is the new thing:
`/creators/did:pkh:eip155:1:0xB41fEE7B3a034a474ae8E0C41DA8B211b73A980B`

Any handle not in that list genuinely has no market, and the app should say so
plainly rather than erroring.

## ★ WALLETS CAN NOW SIGN. This is the headline change.

An Ethereum or Bitcoin wallet is a first-class Magi account: it can register a
market, buy, sell, ask and create offerings, signing with its own key. No Hive
account, no Hive keys. Proven on chain today.

**So:** "this account has no Hive keys and cannot sign a transaction" is a WRONG
message wherever a wallet is connected, and a Buy control disabled for a
wallet-connected user is a BUG. Both were correct yesterday. Report either.

**Deliberately still Hive-only:** LAUNCHING a market from the UI. A wallet user is
told they need a full Hive account. That is a product rule, not a defect — do not
report it as one. DO report it if the wording claims a *technical* reason, because
the contract accepts a wallet creator.

## Known-broken today, do not re-report

- Google sign-in returns 403 on this origin (Cloud Console, owner's).
- Price and holdings appear ~1.1s after the page paints; they are read from chain
  client-side. Slow is expected. WRONG is not.
- A 68-character DID renders as a shortened `0xB41f…980B` handle. That is intended.

**Fixed in round 1 — re-verify rather than re-report, and hunt what each fix may
have broken next door:**
1. Headline price used the contract's TWAP *oracle* feed (0 on an empty market)
   instead of the buyer's price. Now `Area(S+1)-Area(S)` — what a buy charges.
2. A creator with no token was told "we couldn't reach the chain" (the error
   branch shadowed the missing branch).
3. `/creators/@handle` (leading @) falsely said a real market didn't exist.
4. Launch wizard: cap accepted 50 billion; the contract minimum price 0.577 was
   untypeable (2dp vs HBD's 3dp); no ranges stated; Continue never gated.
5. Launch wizard lost all input on refresh/Back — now persists per tab.
6. Lite users had no click path to `/wallet/tokens`, and the Studio was a dead
   end for them (worse than being signed out).
7. The "Before you trade" modal fired for accounts that cannot trade, and was
   marked read on RENDER rather than on dismissal, and was shared across accounts.
8. The services CTA's disabled reason was a hover-only `title`.

The Magi **indexer is NOT configured** in this environment. Discovery ranking,
holder→creator lookups, delivery records and price history all come from it, so
they are expected to say "unavailable". That is the honest state, not a bug —
**but a screen that renders them as empty-and-real IS a bug, and so is one that
blames the chain for it.**

## The signing wall — read this before you file "the button is dead"

Creator-token writes (launch, buy, sell, ask, renew) are **Magi transactions
that need Hive ACTIVE authority**. The signer must be one of keychain,
peakvault, metamask, google or hbauth — all browser extensions or wallet flows
that **do not exist in your headless browser**.

So: you will not complete a purchase. That is expected and is NOT your finding.

**What IS your finding** is everything up to and around that wall:
* Does the app tell you clearly what it needs, before you invest effort?
* Or does it let you fill in a whole form and then fail at the last click?
* Is the failure honest ("you need a Hive account with an active key") or a
  bare "Error", a dead button, or a silent no-op?
* A **lite account** (the normal Lumen signup, which is what most users will
  have) has **no Hive keys at all** and can never sign. Is that said up front,
  on the page where the user first forms the intention — or discovered at the end?

Report exactly where each flow stops and what the user is told at that moment.

## Ground truth you can check numbers against

The curve is `price(i) = 1000 + (63000·i + 21·i²)/8000`, in HBD **base units**
(1000 base units = 1.000 HBD). At supply 0 the next token costs 1000 base units
= 1.000 HBD. HBD is treated as 1:1 with USD in one documented place.

**A number on screen that disagrees with that is worth a finding.** The
coordinator already suspects the spot price renders as `$0.00` at supply 0 when
it should be about `$1.00` — verify it rather than assuming either way.

## House rules for this round

* **NEVER restart, kill or rebuild the server.** No `pnpm build`, no `pnpm
  start`, no `pkill`. Eight of you share one box and one port. A coordinator
  broke this rule yesterday and cost a tester six of their eight steps.
* Your scratch dir is `/tmp/ct-qa/<your-charter-name>/`. Write nothing anywhere else.
* **Do not edit repo files.** You report; the coordinator fixes.
* Do not touch design decisions — colours, copy tone, layout choices, what the
  product chooses to show. Your remit is: **does it work, is it honest, and is
  it more steps than it needs to be.**
* Base URL is `https://localhost:3443` (self-signed). Run node with
  `NODE_EXTRA_CA_CERTS=/home/clauderfly/hive-blog-rebuild/.tls/cert.pem` and
  Playwright contexts with `ignoreHTTPSErrors: true`.
* Use `/home/clauderfly/hive-blog-rebuild/qa-harness.mjs` (`openApp`, `BASE`).
* If something looks like an environment artefact rather than a product defect,
  **say so in the finding** — yesterday's round was contaminated by exactly that
  and the testers who flagged their own uncertainty were the most useful ones.
