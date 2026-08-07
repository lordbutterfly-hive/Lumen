# How to drive Lumen

## Two origins

    https://localhost:3443   PRODUCTION build behind TLS — judge everything here
    http://localhost:3010    DEV build — CREATOR TOKENS ONLY, see below

★ Creator tokens are served from the DEV origin today. The Magi testnet's
GraphQL API is returning 502, so the deployed contract cannot be read, and the
demo data source is deliberately INERT in a production build
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
