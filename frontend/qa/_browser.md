# How to drive Lumen

## Two origins

    https://localhost:3443   PRODUCTION build behind TLS — judge everything here
    http://localhost:3010    DEV build — CREATOR TOKENS ONLY, see below

★ Creator tokens are served from the DEV origin today.

★★ CORRECTION 2026-08-15: the "Magi testnet GraphQL is returning 502" claim
below is STALE. `https://magi-test.techcoderx.com/api/v1/graphql` was curled
directly during a launch-flow E2E and returns HTTP 200 with a working schema,
and the app performed a genuine live contract read against it (a brand-new
account correctly resolved to "no market"). The launch flow is REAL code
against the REAL vsc-testnet contract `vsc1BcaD8JrwJPAAN5cU1cHKCBdZrd7jz2WGt8`
(`.env.local`: `REACT_APP_CREATOR_TOKENS_DEMO=0`, `NET_ID=vsc-testnet`) — the
Mock data source is UNREACHABLE in this environment because
`getCreatorTokensDataSource()` checks for config before the demo flag. So the
reason to use the dev origin is the production-build inertness below, NOT a
dead API. Do not repeat the 502 claim without re-curling it.

The demo data source is deliberately INERT in a production build
(`isCreatorTokensDemoEnabled()` refuses when NODE_ENV=production — a real safety
control, left alone). On the dev origin: judge FLOWS and COPY, never speed (dev
compiles on first hit), and never report a demo figure as real market data.

Also true and NOT a bug: a lite account cannot sign transactions, so it cannot
trade a creator token. Judge how honestly the app says so.

## The production target — HTTPS, and this is not optional

    https://localhost:3443

A **production build** is running on `:3000`; `scripts/lumen-https-front.mjs`
terminates TLS in front of it on `:3443`. You must use the HTTPS origin: in
production the session cookie is `Secure`, so a browser on plain `http://`
accepts it and **never sends it back** — every authenticated request arrives
anonymous and the whole app looks logged-out and broken. That is not a bug you
found; that is you testing the wrong origin.

## Your tools

`qa-harness.mjs` at the repo root gives you a real Chromium browser with a real
signed-in session. Write a small `.mjs` script in your scratch area and run it:

```js
import { openApp, visit, numbersOnPage, clickAndWatch, report, BASE }
  from '/home/clauderfly/hive-blog-rebuild/qa-harness.mjs';

// loggedIn: true creates a BRAND NEW lite account over the real API
const { browser, page, username, consoleErrors, failedRequests } =
  await openApp({ loggedIn: true, label: 'yourlane' });

await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 120000 });
// ... drive it ...
await page.screenshot({ path: '/tmp/<yourlane>-<what>.png' });
await browser.close();
```

Run it with the local certificate trusted:

    cd /home/clauderfly/hive-blog-rebuild
    NODE_EXTRA_CA_CERTS=$PWD/.tls/cert.pem node /tmp/<yourlane>.mjs

★ **GIVE YOURSELF YOUR OWN IDENTITY.** `openApp({ loggedIn: true })` with no
`privateKey` uses the harness's HARDCODED default key — which means every agent
running at the same time is signed in as the SAME person, and last round two
testers correctly refused to trust follow-state they saw because of it. Generate
one key at the top of your first script and reuse it for your whole session:

```js
// 64 hex chars. Make it yours — do not copy this one.
const MY_KEY = '0x' + 'b7'.repeat(32);
const { page, username } = await openApp({ loggedIn: true, privateKey: MY_KEY, label: 'mylane' });
```

Omit `privateKey` only when you specifically want a brand-new account (testing
first-run). Passing the same key again returns you as the same person, which is
how you test sign-out and sign-back-in. `consoleErrors` and `failedRequests` accumulate for
the page's whole life; read them at the end, they catch what the UI hides.

Helpers: `visit(page, path)` returns `{ms, status, bodyText, empty}`;
`numbersOnPage(page)` returns every number a human can see (skips `<script>`);
`clickAndWatch(page, name)` clicks by accessible name and reports whether it was
found, disabled, clicked, and whether the URL changed.

## Wait properly, or you will report ghosts

Use `waitUntil: 'networkidle'` **and** a settle pause (2–4s) before you judge a
page. The server renders logged-out chrome first and swaps it after
`/api/users/me` resolves — sampling too early caught that frame and reported a
working header as broken. When you assert something is missing, wait for
something that *should* be there first.

## Hard rules

- **Never kill, restart or `pkill` the dev/production server, and never run
  `pnpm build` or `pnpm start`.** Several agents share one box.
  ★ 2026-08-07: the coordinator broke this rule and it cost a tester six of
  their eight charter steps. A second Next instance was started in the same
  workspace; both default to `apps/blog/.next`, so `next dev` overwrote the
  production build under the live process — BUILD_ID emptied, every static
  chunk 500'd, every route but `/` returned a bare "Internal Server Error".
  If you ever see that signature, it is almost certainly a build in progress
  and NOT a product defect: say so, wait, and re-check before filing.
- **Never broadcast to Hive mainnet from a Hive-keyed account.** Lite accounts
  publish through the proxy and that is fine — that is the product. Do not run
  `qa-hive-keyed-post.mjs`.
- **Do not edit application source.** You are testing, not fixing. Report it.
- Write scratch scripts and screenshots under `/tmp/`.
- The signup rate limit has been raised for this QA run, so you should not hit
  it. If you DO see a **429**, stop creating accounts, reuse one session, and say
  so in your report — do not report it as a product bug.

## Known and already-being-worked — do NOT re-report these

Config gaps, not defects:
- Google sign-in button is disabled: the OAuth client id is a placeholder.
- "Prediction market isn't available yet": the contract is not deployed.
- `/creators` needs an indexer URL that is not configured.
- The launch wizard does not advance past step 1.
- Sorting search by "Newest" times out on broad terms (upstream Hive limit); it
  now says so and offers relevance.

Deliberate product decisions, already raised with the owner — do not re-file:
- Followers/Following pages still use the older visual style.
- The Topics rail is global trending, not personalised to your interests.
- The "For You" feed's weighting of your picked interests.

★ FIXED SINCE THE LAST ROUND — these are now regression targets, so if you see
any of them come BACK, that is a high-value finding:
- The Following tab (lite accounts) now has its own feed and works.
- Search survives an apostrophe (`don't`, `O'Brien`).
- Lite post pages no longer show a raw `WaxAssertionError` toast.
- Publishing confirms with a toast, from both the composer and the full editor.
- Submit is disabled on an empty or whitespace-only title/body, in edit too.
- Error toasts show a readable message, not just the word "Error".
- Post bylines show a community NAME, never `#hive-174301`.
- Broken avatars fall back to a generated one instead of blank space.
- A lite author can delete their own post; the control is on the post page.
- An empty tag page says so instead of blaming the node.
- No `/api/streak` calls and no "similar posts" calls for accounts that cannot
  have them.

Anything else is fair game.

---

# Sign in as a REAL account — do this before you test anything

**★ Added 2026-08-08, on the owner's instruction, after five rounds of testers
returned "clean" on pages the owner broke in seconds.**

## The reason you have been finding nothing

Every previous tester signed up a brand-new lite account and browsed as a person
with no history — no follows, no feed, no posts, no wallet balance, no
notifications, no tokens. **Nearly every screen they judged was an empty state.**
An empty state looks fine no matter how broken the populated one is. A feed with
nothing in it cannot show you a broken card, a wrong vote count, a duplicated
sidebar, a misaligned pill, or a payout that renders as `NaN`.

Real examples from this codebase, each of which several testers walked straight
past while reporting the surrounding page as clean:

- The profile Posts tab was seeded by a DIFFERENT query than the one it
  refetched with — invisible unless the account has posts.
- Trending/Hot/Created rendered their sidebar **twice**. Nobody noticed, because
  nobody looked at a page they had no reason to visit.
- `/api/lite/posts` served every post on the platform to anyone. It reads as a
  normal feed unless you ask who is allowed to see it.
- The feed reported "log in to see recommendations" to signed-in readers — only
  reachable when the ranker degrades, which never happens on a fresh account.

So: **an empty screen is not a passing screen.** If a page has nothing on it,
your first job is to get content onto it, and only then judge it. If you cannot,
say the page was UNTESTED for lack of data — never "clean".

## How to sign in

```js
import pw from '<repo>/node_modules/.pnpm/playwright@1.49.1/node_modules/playwright/index.js';
const { chromium } = pw;
const { signedInStorageState } = await import('<repo>/qa/harness/session.mjs');

const storageState = await signedInStorageState();          // hbd-temp, full tier
const browser = await chromium.launch();
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, storageState });
```

Confirm it took before you judge anything:

```js
await page.goto('https://localhost:3443/');
const me = await page.evaluate(() => fetch('/api/users/me', { credentials: 'include' }).then(r => r.json()));
// expect: { isLoggedIn: true, username: 'hbd-temp', account_tier: 'full' }
```

If `isLoggedIn` is false, **stop** — everything you test after that is the
signed-out product, and reporting it as the signed-in one is how a whole round
gets wasted.

## What this account can and cannot do

`hbd-temp` is Lumen's own shared frontend account. It is a real, full-tier Hive
account, so you get the real signed-in product: your profile, the wallet, the
ranked feed, settings, notifications, creator tokens, and every Lumen-local
action (votes, follows, reblogs) and lite write that goes through the publisher.

It **cannot sign a Hive transaction in the browser.** Chain signing needs a key
in the Keychain extension, which no headless browser has, and this session
deliberately carries no key. If a flow stops and asks for Keychain, that is the
boundary of what you can test — **report it as UNTESTABLE, never as broken.**

Two more things to know, so you do not mis-file them:

- **`hbd-temp` follows 20 real accounts on chain** (blocktrades, theycallmedan,
  ecency and others), so its Following tab shows a real 20-post chain feed.
  ★ This paragraph previously said the opposite — "follows nobody, so its
  Following tab is legitimately empty" — which would have led a tester to file a
  working feed as a bug, or to accept an empty one as correct. Corrected
  2026-08-09 after a tester checked it against
  `condenser_api.get_following` rather than trusting this file. Verify account
  facts against the chain; this doc is not authoritative about them.
- Anything you do lands in the shared database under this one account, and other
  testers are using it too. Namespace what you create (put your run id in
  titles), and never assume a row you find is yours.

## ★ WRITES THAT GO TO THE HIVE CHAIN DO NOT WORK IN THIS SESSION — and the errors are the harness's fault, not the product's

Added 2026-08-08 after a tester spent an evening filing this as a High.

`hbd-temp` signs in here through a **forged session cookie**. That is enough for
the server to know who you are, so every READ is real. It is NOT enough for the
BROWSER to sign anything: the real login flow also populates a client-side signer
that this shortcut never touches.

So **upvote, comment, reblog and follow-on-a-Hive-profile all fail**, and they
fail ugly — you will see raw strings like `WaxProtocolAssertionError ... Account
name '' is too short`, `TypeError: Cannot read properties of undefined (reading
'username')`, or `Invalid loginType`. All three mean the same thing: the signer
was never set up, because you did not log in the normal way.

**Do not file these. They are an artifact of how you signed in.** A real reader
who signed in with Keychain has the extension and a populated signer.

What you CAN still test on the write side:
- **Lumen-local actions on lite content** — these go through the server, not a
  chain signature, and are genuinely exercised.
- **Everything up to the wall**: does the button exist, is it enabled, is it in
  the right place, does the form validate, does it tell you what will happen.
- **What the UI does WHEN a write fails** — that IS fair game and worth reporting
  as a UX finding, as long as you describe it as "the failure path looks like X",
  not "voting is broken."

If you need to prove a write end to end, say so in your report as UNTESTABLE and
name what you would have checked. Do not guess, and do not report the harness's
own limitation as a product defect.

You may still create your own lite account when you specifically need a
first-time-user view — signup, onboarding, the interest picker. For everything
else, use the account with content in it.
