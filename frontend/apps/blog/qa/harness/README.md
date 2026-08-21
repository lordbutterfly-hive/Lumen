# The frontend harness

A set of checks that run against **every page**, built from research into what LLM coding
agents demonstrably get wrong on frontend work, and from bugs this repo has actually
shipped.

**If you are an agent asked to test this app, this file is the contract. Follow it.
Do not invent your own checks and report them as harness results.**

---

## Why this exists

Measured failure modes of agent-written frontend code (sources in
`/mnt/o/LUMEN-DOCS/`, research 2026-08-18):

| What agents do | Evidence |
|---|---|
| Verify the one page they edited, never the others it broke | Documented: a global `.nav-item` edit silently distorted footer, tabs and admin panels |
| Treat "it type-checks" as "it works" | Cursor's own docs list false confirmations and post-edit regressions as known limitations |
| Write tests that pass vacuously | **36%** of agent test commits add mocks vs 26% for humans (MSR 2026, 1.2M commits, 2,168 repos) |
| Miss empty / error / loading states | Agents build the success case; the other three ship broken |
| Leave dead code after refactors | LLM "remove dead code" fixes frequently break call sites they never looked at |
| Miss perf regressions | Vercel shipped a 57-rule agent skill specifically because default agent output regresses waterfalls and bundle size |
| Miss hydration mismatches | Agents "fix" SSR divergence by wrapping in `useEffect`, which *causes* the mismatch |

Bug counts in AI-authored PRs are measurably higher: **+28.7% bugs per PR**, 3× incidents
per PR (Faros AI telemetry, 22,000 devs). This harness is the counterweight.

---

## What it checks

### Per page, every page (`sweep.mjs`)

| Check | Catches |
|---|---|
| Console errors + `pageerror` | Runtime failures invisible in a screenshot |
| **Hydration mismatch** | SSR/client divergence — React silently reconciles, so the console line is the *only* evidence. Never allowlisted. |
| Failed requests + 4xx/5xx | Broken APIs behind a page that still renders |
| Broken images | `naturalWidth === 0` after a scroll pass (lazy-loading aware) |
| Horizontal overflow + culprits | Mobile breakage, with the offending elements named |
| Zero-size interactive elements | Buttons that exist but cannot be clicked |
| **Covered interactive elements** | `elementFromPoint` hit-test — the same question Playwright asks before every click |
| Text clipped by its container | Copy or translation growth silently truncating |
| `[object Object]` / `Invalid Date` / `undefined` / `NaN` / raw i18n keys | Data leaking into the UI as text |
| **IACVT CSS** | See below — the detector nothing else has |
| Heading level jumps | h2 → h4, invisible visually, real for screen readers |
| `<title>`, `<html lang>`, exactly one `<h1>` | Page-level basics |
| Rendered at all | **A blank page FAILS. It is never recorded as clean.** |

### The IACVT detector (`detectors/css-iacvt.mjs`)

**This exists because this exact bug shipped here on 2026-08-18.**

```js
backgroundColor: 'var(--background)'   // --background holds `0 0% 100%`
```

`var()` is syntactically valid for any property, so this **parses fine**. The substituted
value fails `<color>`'s grammar at *computed-value time*, so the declaration silently
resolves to `transparent`. No console warning. No devtools strikethrough. The ring
rendered as a filled disc and buried the rank emblem, the daily card's count, and the
user's own avatar under three stacked circles.

| Tool | Why it misses this |
|---|---|
| stylelint | validates source text; `var(--x)` is always legal syntax |
| CDP `parsedOk` | parsing **succeeds**; failure is downstream |
| TypeScript | it's a string in a style object |
| axe contrast | checks *text* contrast, not a background behind a glyph |

**It is two-part, and both parts are required.** Verified empirically:

| declaration | var holds | computed | probe |
|---|---|---|---|
| `background-color: var(--background)` | `0 0% 100%` | `rgba(0,0,0,0)` | rejects ← **bug** |
| `background-color: hsl(var(--background))` | `0 0% 100%` | `rgb(255,255,255)` | rejects ← **correct code** |

The runtime probe *alone* flags correct code. The static scan supplies the missing
half: is the `var()` used **bare**, or wrapped in a colour function? Only failing both
is reported. On this codebase that reduces 12 candidates to 0 false positives.

Two bugs were found in the detector by running it, both now fixed and documented in the
file: it originally missed JS style objects (i.e. the very bug it was written for), and
it flagged its own doc comment.

---

## Running it

**Against a production build. Never `next dev`** — dev compiles per route (45.8s vs 0.84s
measured here), intercepts errors before they reach the real `error.tsx`, and hydrates
differently. A dev sweep measures the dev server.

```bash
NEXT_DIST_DIR=.next-qa pnpm build \
  && LUMEN_ENABLE_HEALTHCHECKER=yes NEXT_DIST_DIR=.next-qa pnpm start   # shell 1

node qa/harness/sweep.mjs --state=anon                    # signed out, 1440x900
node qa/harness/sweep.mjs --state=auth --user=lordbutterfly
node qa/harness/sweep.mjs --state=anon --viewport=390x844  # phone
node qa/harness/api-sweep.mjs                              # all 95 app/api routes
node qa/harness/verify-changes.mjs                         # regression checks (pnpm qa:changes)
node qa/harness/anti-cheat.mjs HEAD                        # test-weakening scan
```

> **Why `LUMEN_ENABLE_HEALTHCHECKER=yes` is on that line.** `/healthchecker` calls
> `notFound()` whenever `NODE_ENV === 'production'` and that flag is unset — and this
> harness deliberately runs a production build, so without it the route 404s for us
> exactly as it does for a visitor. That is not hypothetical: started without the flag,
> **29 of 30 `healthchecker.spec.ts` tests failed**, every one of them timing out
> waiting for a tab on a 404 page. With it set: **15 passed**. (The other 15 wait on
> `mobile-nav-trigger`, which is a separate, mobile-only issue.) The flag is read
> server-side only and can never be set by a visitor, so enabling it here changes
> nothing about the real deployment. See the long note in `app/healthchecker/layout.tsx`.


Exit codes: `0` clean · `1` findings · `2` aborted (harness itself is broken) ·
`3` nothing to inspect.

Reports land in `qa/harness/reports/*.json`.

---

## The rules — non-negotiable

These make a green run mean something. Violating one produces a *fake* clean bill, which
is worse than no run at all.

1. **An empty check FAILS.** Zero pages swept, zero elements found, an empty diff — none
   of these are passes. `sweep.mjs` aborts on zero pages inspected; `anti-cheat.mjs`
   exits 3 on an empty diff.
2. **Assert non-emptiness before asserting content.** Every fixture load, query and
   element sweep.
3. **The route list is derived, not typed.** `routes.mjs` reads the filesystem and
   cross-checks against `EXPECTED_PAGE_COUNT`. A dynamic route with no sample is a hard
   error, never a skip — skipping it would silently drop a page while claiming full
   coverage.
4. **Detectors self-test before the run.** The IACVT detector proves it still catches a
   known-bad fixture and still ignores a known-good one, or the sweep aborts. A detector
   that has stopped detecting reports "clean" forever.
5. **Report what you actually ran.** Pages inspected and checks executed are in every
   report. "I checked 68 of 1,482" is an acceptable sentence. "Coverage complete" when it
   is not, is not.
6. **Never weaken a check to make it pass.** Widening a tolerance, deleting an assertion,
   `.skip`, regenerating a snapshot — `anti-cheat.mjs` blocks all four. If a check is
   wrong, fix the check and say why in the same commit.
7. **Findings are hypotheses until reproduced.** Report the URL, the exact issue string
   and how to re-run it. A finding nobody else can reproduce costs credibility.

---

## For agents running this

Do this, in order. Do not substitute your own method.

1. Confirm the server is on a **production** build (`NEXT_DIST_DIR=.next-qa`, port 3000).
2. Run the sweep for your assigned state/viewport. **Do not edit `routes.mjs` to shrink
   the list.**
3. Read the JSON report. For every page with issues, **open that page yourself** and
   confirm the finding is real before reporting it.
4. Report: pages inspected, checks run, findings confirmed, findings that did **not**
   reproduce. All four numbers.
5. If the harness aborts (exit 2), the harness is broken — say so. Do not work around it
   by disabling a detector.
6. Do not report a clean result you did not earn. If you swept 12 of 55 URLs, say 12.


## api-sweep.mjs

Probes every route under `app/api/**` (95 at time of writing), enumerated from the
filesystem AND cross-checked against `.next-qa/routes-manifest.json` and
`app-path-routes-manifest.json`. A disagreement between those sources is itself a finding
and fails the run - it is how a route goes missing without anyone noticing.

It gates only on things that are unambiguously wrong: a 500, HTML where JSON belongs, a
200 with an empty body, an apparent missing auth gate, or a response over 5s. It does NOT
gate on 401/403/404/405, which are correct answers to an unauthenticated probe.

Mutating routes are probed with no auth header and an empty body, which every one of them
rejects at its guard before touching anything - each guard was read individually to
confirm it is the unconditional first statement. Zero routes are skipped, and that is
earned rather than assumed; the `DESTRUCTIVE_SKIP` map exists (empty) for the day that
stops being true.

**Known gap it reports rather than hides:** `pages/api/**` is a SECOND, older API surface
this sweep's `app/api/**` scope structurally cannot see - `login`, `logout`, `consent`,
`chat-token`, `users/me` and `oidc` live there, unprobed by any harness today.


## verify-changes.mjs

Asserts the specific things that were fixed STAY fixed, measured against the running
build: the design tokens, the radius ladder, `--header-h` against the real header height
at two breakpoints, tabular numbers on the post card's action row, `<h1>` presence and
heading-level continuity, the action-row icon colour, the single comment glyph, the nav
seat and rule, that no live link depends on a retired-sort redirect, that a post-body
hashtag resolves 200 in ONE hop, and that Google sign-in actually renders.

**Why the Google check is in here.** It is not fixable in code - the origin has to be
registered in Google Cloud Console - and precisely because of that it kept coming back and
kept being rediscovered by hand, in a browser, after being reported fixed. A failure that
only a human can find is a failure that repeats. It fails loudly and prints the client ID
and the fix.

Two checks refuse to pass vacuously rather than report a clean run they did not earn: the
hashtag check walks up to 8 posts and reports INCONCLUSIVE if none carries a tag, and the
post-body CLS check reports inconclusive if it cannot sample a post with images.
