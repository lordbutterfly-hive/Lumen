/**
 * The replies-per-post ratio's walk-depth gate — plain assertions, no test runner
 * (same convention as `ladder.test.ts`: this repo has none, and adding one is out
 * of scope for this job).
 *
 * RUN IT (from `apps/blog`):
 *   pnpm exec ts-node -r tsconfig-paths/register \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node","jsx":"react-jsx"}' \
 *     features/retention/lib/__tests__/ratio-depth-gate.test.ts
 *
 * Both overrides are required, and both were found by running it, not guessed:
 *   - `-r tsconfig-paths/register` — this file's dependency graph pulls in
 *     `@/blog/*`-aliased imports (via `retention-stats.tsx`), which plain `ts-node`
 *     (as `ladder.test.ts`'s own header documents it) cannot resolve; confirmed
 *     live, `ladder.test.ts` fails the same way without the flag.
 *   - `"jsx":"react-jsx"` — the project tsconfig sets `jsx: "preserve"` (Next.js
 *     transforms JSX itself); under plain `ts-node` that leaves `<div>` untouched
 *     in the emitted JS and Node's own `require` throws `Unexpected token '<'` the
 *     moment anything imports `retention-stats.tsx`, even only for its plain
 *     exported functions — the file also exports a component.
 *
 * Exits 0 when every check passes, 1 (and prints each failure) otherwise.
 *
 * WHAT IS PROVEN HERE
 *
 * `retention-stats.tsx:208-212` used to print "Replies Nx for every post" (or the
 * "about equally" variant) whenever `postsInWindow + repliesInWindow >= 8`, with no
 * regard for how the two counts were measured. They come from two INDEPENDENT feed
 * walks (route.ts:735-736) that each truncate on their own clock/page budget, and
 * under load they read to very different depths — measured live at ~185 days for
 * posts against ~21-32 days for replies. Live, that printed "about equally" for a
 * user whose real rate was ~10.2 replies per post.
 *
 * ★★ SECOND CORRECTION, SAME DAY (2026-08-11). The first fix gated on an ABSOLUTE
 * gap between the two depths, scaled by the lookback window. An adversarial reviewer
 * executed the real functions and showed that gate was the WRONG SHAPE: it bounds a
 * day GAP, but the thing that actually breaks the ratio math is a depth RATIO, and a
 * window-scaled gap tolerance does nothing to bound the ratio that can hide behind
 * it — shrinking the window shrinks the tolerance right along with the gap it is
 * measuring, leaving the ratio unbounded at every window size. Section 2 below
 * table-drives the five measured rows that proved it (four of which the old gate
 * PASSED, wrongly) against the new relative gate.
 *
 * The fix is `walksAreComparablyDeep` gating `voiceLine`, both exported from
 * `retention-stats.tsx` specifically so this can be tested without a React render
 * context (`voiceLine` takes `t` as a parameter rather than calling
 * `useTranslation`, exactly like that file's existing `sampleNote`).
 *
 *   1. `daysBack` — the ISO-to-depth arithmetic the gate is built on.
 *   2. `walksAreComparablyDeep` — the gate itself: the relative-ratio test (0.75),
 *      the absolute floor (5 days) that protects a brand-new account, both of their
 *      exact boundaries, proof the gate no longer depends on `windowWeeks` at all,
 *      and the empty/missing-timestamp cases.
 *   3. `voiceLine` — the acceptance criterion: mismatched `oldestSeen` values (the
 *      live bug's own numbers, in both the old absolute-gap shape and the new
 *      ratio shape) must make the line ABSENT, and the young-account case the floor
 *      protects must still make the line PRESENT.
 */

import type { RetentionCoverage } from '../../hooks/use-retention';
import type { RetentionStats } from '../../types';
import { daysBack, voiceLine, walksAreComparablyDeep } from '../../components/retention-stats';

let checks = 0;
let failures = 0;
const out = (s: string) => process.stdout.write(s + '\n');

function check(name: string, ok: boolean, detail = ''): void {
  checks++;
  if (!ok) {
    failures++;
    out(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(name: string): void {
  out(`\n${name}`);
}

// ─── helpers ────────────────────────────────────────────────────────────────

/** An ISO timestamp `days` ago, in the no-`Z` shape Hive's `created` field actually uses. */
const daysAgoISO = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString().replace(/Z$/, '');

const coverage = (postsOldestSeen: string, commentsOldestSeen: string, windowWeeks = 26): RetentionCoverage => ({
  windowWeeks,
  postsOldestSeen,
  commentsOldestSeen,
  capped: false,
  activeWeeksIsLowerBound: false,
  commentsFeedUnavailable: false
});

const stats = (postsInWindow: number, repliesInWindow: number): RetentionStats => ({
  people: 1,
  postsInWindow,
  repliesInWindow
});

/** Records every call so a test can assert both on the return value and on what
 * the translation key/vars actually were, without pulling in i18next. */
function fakeT(): { t: (key: string, vars?: Record<string, unknown>) => string; calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = [];
  return {
    calls,
    t: (key: string, vars?: Record<string, unknown>) => {
      calls.push([key, vars]);
      return `${key}(${JSON.stringify(vars ?? {})})`;
    }
  };
}

// ─── 1. daysBack ────────────────────────────────────────────────────────────

section('1. daysBack — ISO timestamp to depth');

check('undefined is NaN, not zero', Number.isNaN(daysBack(undefined)));
check("empty string is NaN, not zero — the '0 items ever' / 'call failed' collision", Number.isNaN(daysBack('')));
check('an unparseable string is NaN', Number.isNaN(daysBack('not-a-date')));
{
  const d = daysBack(daysAgoISO(10));
  check('10 days ago reads back as ~10 (within 0.01 day of clock jitter)', Math.abs(d - 10) < 0.01, `got ${d}`);
}
{
  const d = daysBack(daysAgoISO(0));
  check('today reads back as ~0', Math.abs(d) < 0.01, `got ${d}`);
}
{
  // Hive's real `created` field has no trailing Z (route.ts strips/reattaches it
  // the same way before parsing) — prove a bare ISO-shaped string with no Z at all
  // is treated as UTC, not as local time, or this whole gate silently drifts by the
  // runner's UTC offset.
  const bare = new Date(Date.now() - 5 * 86_400_000).toISOString().replace(/\.\d+Z$/, '');
  const d = daysBack(bare);
  check('a Z-less timestamp is still parsed as UTC', Math.abs(d - 5) < 0.02, `got ${d}`);
}

// ─── 2. walksAreComparablyDeep ──────────────────────────────────────────────

section('2. walksAreComparablyDeep — the relative gate, its floor, its boundaries');

check('undefined coverage fails the gate', !walksAreComparablyDeep(undefined));
check('both oldestSeen empty fails the gate (unknown depth, not zero depth)', !walksAreComparablyDeep(coverage('', '')));
check(
  'posts empty, comments present fails the gate',
  !walksAreComparablyDeep(coverage('', daysAgoISO(30)))
);
check(
  'comments empty, posts present fails the gate',
  !walksAreComparablyDeep(coverage(daysAgoISO(30), ''))
);

// ★★ THE TABLE. Each row is either a number the reviewer measured against the OLD
// (absolute-gap) gate, or a boundary of the NEW (relative-ratio + absolute-floor)
// gate. `windowWeeks` is varied deliberately on several rows and must never change
// the verdict — that independence IS the fix; the old gate's tolerance moved with
// the window, which is exactly how a 46x depth ratio slipped through on a narrow
// window and, at full scale, on the default one too.
type Row = { label: string; postsDays: number; repliesDays: number; windowWeeks?: number; pass: boolean };

const rows: Row[] = [
  // ── the reviewer's five measured rows — four the OLD gate wrongly PASSED ──────
  { label: 'posts=46d replies=1d, ratio 46.0x — old gate PASSED this (wrong)', postsDays: 46, repliesDays: 1, pass: false },
  { label: 'posts=45d replies=0.5d, ratio 90.0x — old gate PASSED this (wrong)', postsDays: 45, repliesDays: 0.5, pass: false },
  { label: 'posts=50d replies=5d, ratio 10.0x — old gate PASSED this (wrong)', postsDays: 50, repliesDays: 5, pass: false },
  { label: 'posts=185d replies=21d, ratio 8.8x — old gate correctly blocked', postsDays: 185, repliesDays: 21, pass: false },
  {
    label: 'posts=8d replies=1d on a 4-week window, ratio 8.0x — old gate PASSED this (wrong)',
    postsDays: 8,
    repliesDays: 1,
    windowWeeks: 4,
    pass: false
  },

  // ── the real production numbers this fix was verified against, live ──────────
  { label: 'posts=401.7d replies=32.0d (live @lordbutterfly, ratio 12.6x) must block', postsDays: 401.7, repliesDays: 32.0, pass: false },

  // ── the case the absolute floor exists to protect ─────────────────────────────
  { label: 'posts=3d replies=1d — brand-new account, both walks genuinely out of history', postsDays: 3, repliesDays: 1, pass: true },
  { label: 'posts=0d replies=0d — both walks stop today', postsDays: 0, repliesDays: 0, pass: true },
  { label: 'two walks that read the same depth (90d vs 90d)', postsDays: 90, repliesDays: 90, pass: true },

  // ── the 5-day absolute-floor boundary itself ──────────────────────────────────
  { label: 'gap exactly 5 days (6d vs 1d, ratio 0.167) — floor alone rescues it', postsDays: 6, repliesDays: 1, pass: true },
  {
    label: 'gap 5.1 days (6.1d vs 1d, ratio 0.164) — past the floor, falls to the ratio test and fails',
    postsDays: 6.1,
    repliesDays: 1,
    pass: false
  },

  // ── the 0.75 ratio boundary, gap comfortably clear of the floor ───────────────
  { label: 'ratio exactly 0.75 (100d vs 75d, gap 25d)', postsDays: 100, repliesDays: 75, pass: true },
  { label: 'ratio just under 0.75 (100d vs 74d, gap 26d)', postsDays: 100, repliesDays: 74, pass: false },

  // ── window-independence: the whole point of the fix ────────────────────────────
  // Same two rows as above, replayed under a 4-week window. A gate that still reads
  // `windowWeeks` would move these; this one must not.
  { label: 'posts=50d replies=5d, ratio 10.0x, replayed under a 4-week window — still blocks', postsDays: 50, repliesDays: 5, windowWeeks: 4, pass: false },
  { label: 'posts=150d replies=140d, ratio 0.93, replayed under a 4-week window — still passes', postsDays: 150, repliesDays: 140, windowWeeks: 4, pass: true }
];

for (const row of rows) {
  const maxDepth = Math.max(row.postsDays, row.repliesDays);
  const minDepth = Math.min(row.postsDays, row.repliesDays);
  const ratio = maxDepth === 0 ? 1 : minDepth / maxDepth; // display only; 0/0 (both walks stop today) reads as "no distortion"
  const gap = Math.abs(row.postsDays - row.repliesDays);
  const detail = `depthRatio=${ratio.toFixed(3)} gap=${gap.toFixed(1)}d`;
  const forward = coverage(daysAgoISO(row.postsDays), daysAgoISO(row.repliesDays), row.windowWeeks);
  check(`${row.label} → ${row.pass ? 'passes' : 'blocks'}`, walksAreComparablyDeep(forward) === row.pass, detail);

  // Symmetry: the gate must not care which side is "posts" and which is "replies" —
  // min/max are commutative, so swapping the two depths must reach the same verdict.
  const swapped = coverage(daysAgoISO(row.repliesDays), daysAgoISO(row.postsDays), row.windowWeeks);
  check(`${row.label} (swapped posts/replies) → ${row.pass ? 'passes' : 'blocks'}`, walksAreComparablyDeep(swapped) === row.pass, detail);
}

// ★ windowWeeks is now fully inert: missing/absurd values must not change a verdict
// that the table above already pinned down at windowWeeks 4 and 26.
{
  const blocking = (windowWeeks?: number) =>
    walksAreComparablyDeep({
      windowWeeks: windowWeeks as unknown as number,
      postsOldestSeen: daysAgoISO(50),
      commentsOldestSeen: daysAgoISO(5),
      capped: false,
      activeWeeksIsLowerBound: false,
      commentsFeedUnavailable: false
    });
  check('windowWeeks undefined still blocks the 50d/5d case', !blocking(undefined));
  check('windowWeeks 1 still blocks the 50d/5d case', !blocking(1));
  check('windowWeeks 1000 still blocks the 50d/5d case', !blocking(1000));
}

// ─── 3. voiceLine — the acceptance criterion ────────────────────────────────

section('3. voiceLine — mismatched oldestSeen makes the LINE absent');

{
  const { t } = fakeT();
  check('no stats at all → absent', voiceLine(undefined, coverage(daysAgoISO(90), daysAgoISO(90)), t) === undefined);
}
{
  const { t } = fakeT();
  check(
    'postsInWindow missing → absent',
    voiceLine({ people: 1, repliesInWindow: 20 }, coverage(daysAgoISO(90), daysAgoISO(90)), t) === undefined
  );
}
{
  const { t } = fakeT();
  check(
    'below the p+r >= 8 floor, even with comparable depth → absent',
    voiceLine(stats(3, 2), coverage(daysAgoISO(90), daysAgoISO(90)), t) === undefined
  );
}

{
  // ★★ THE CASE THIS JOB EXISTS TO FIX. Real, sizeable counts (p+r well over 8,
  // ratio ~10.2 exactly like the live report) but the two walks that produced them
  // read to very different depths. Before this fix the line rendered "about
  // equally"; after it, it must not render at all.
  const { t, calls } = fakeT();
  const mismatched = coverage(daysAgoISO(185), daysAgoISO(21));
  const line = voiceLine(stats(102, 10), mismatched, t);
  check('mismatched oldestSeen (185d posts vs 21d replies) → line is ABSENT', line === undefined, JSON.stringify(line));
  check('and the translator was never even called', calls.length === 0, JSON.stringify(calls));
}
{
  const { t } = fakeT();
  const mismatched = coverage(daysAgoISO(185), daysAgoISO(32));
  const line = voiceLine(stats(102, 10), mismatched, t);
  check('mismatched oldestSeen (185d posts vs 32d replies) → line is ABSENT', line === undefined, JSON.stringify(line));
}
{
  // Same counts, comparable depth this time — the line MUST come back, or the gate
  // has become "never show this line" rather than "only show it when honest".
  const { t, calls } = fakeT();
  const comparable = coverage(daysAgoISO(150), daysAgoISO(140));
  const line = voiceLine(stats(102, 10), comparable, t);
  check('comparable oldestSeen → line is PRESENT', line !== undefined);
  check("id is 'voice'", line?.id === 'voice');
  check(
    'renders the poster form (10 replies for 102 posts → replies is the minority)',
    calls.length === 1 && calls[0][0] === 'retention.stats.poster'
  );
  const posterVars = calls[0]?.[1] as { count: number } | undefined;
  check('rounds 102/10 = 10.2 to 10', posterVars?.count === 10);
}
{
  // The mirror case — replier, not poster — through the same gate.
  const { t, calls } = fakeT();
  const comparable = coverage(daysAgoISO(140), daysAgoISO(150));
  const line = voiceLine(stats(10, 41), comparable, t);
  check('replier form fires when replies dominate', line !== undefined);
  check(
    'renders the replier key',
    calls.length === 1 && calls[0][0] === 'retention.stats.replier'
  );
  const replierVars = calls[0]?.[1] as { count: number } | undefined;
  check('rounds 41/10 = 4.1 to 4', replierVars?.count === 4);
}
{
  // A genuinely-zero-comments account: `commentsOldestSeen` is '' because that
  // feed ran out of history on page 0, not because it was truncated by load — but
  // the wire cannot distinguish that from a totally-failed call, which is also ''.
  // The gate must stay silent rather than guess, per this file's ABSENT-NEVER-ZERO
  // rule; a poster-only line is worth less than a wrong one.
  const { t } = fakeT();
  const line = voiceLine(stats(12, 0), coverage(daysAgoISO(90), ''), t);
  check("commentsOldestSeen === '' (zero-ever or call-failed, indistinguishable) → absent", line === undefined);
}

{
  // ★★ THE SECOND CORRECTION'S OWN ACCEPTANCE CASE. `stats.repliesInWindow` here is
  // huge relative to the (undercounted) window the replies walk actually managed —
  // this is the exact shape the reviewer used to catch @lordbutterfly's `voiceLine`
  // printing "poster" for someone whose real ratio would say the opposite. The OLD
  // absolute-gap gate PASSED all of these (gap 44.5-45.0d, under its ~45.5d
  // tolerance); the ratio gate must block every one at the line level, not just
  // inside `walksAreComparablyDeep` in isolation.
  const { t, calls } = fakeT();
  const line = voiceLine(stats(46, 20), coverage(daysAgoISO(46), daysAgoISO(1)), t);
  check('ratio-shape mismatch (46d posts vs 1d replies, ratio 46.0x) → line is ABSENT', line === undefined, JSON.stringify(line));
  check('and the translator was never even called', calls.length === 0, JSON.stringify(calls));
}
{
  // The real production numbers from the live endpoint this fix was verified
  // against (see this file's header / the report this test file ships with):
  // @lordbutterfly measured at postsOldestSeen ~401.7d, commentsOldestSeen ~32.0d.
  const { t } = fakeT();
  const line = voiceLine(stats(120, 40), coverage(daysAgoISO(401.7), daysAgoISO(32.0)), t);
  check('live @lordbutterfly numbers (401.7d posts vs 32.0d replies, ratio 12.6x) → line is ABSENT', line === undefined);
}

{
  // ★★ THE YOUNG-ACCOUNT CASE THE FLOOR EXISTS TO PROTECT — asserted at the LINE
  // level, not just inside `walksAreComparablyDeep`. A brand-new account whose posts
  // walk reached back 3 days and whose replies walk reached back 1 day is not a
  // truncation bug (both simply ran out of real history within 2 days of each
  // other, well inside the 5-day floor) and MUST still print, or the fix has
  // overcorrected into "never show this line for a new account".
  const { t, calls } = fakeT();
  const young = coverage(daysAgoISO(3), daysAgoISO(1));
  const line = voiceLine(stats(5, 4), young, t);
  check('young account (3d posts vs 1d replies, p+r=9) → line is PRESENT', line !== undefined, JSON.stringify(line));
  check(
    'renders the poster form (4 replies for 5 posts → replies is the minority)',
    calls.length === 1 && calls[0][0] === 'retention.stats.poster'
  );
}

// ─── summary ────────────────────────────────────────────────────────────────
out('');
out(failures === 0 ? `PASS — ${checks} checks` : `FAIL — ${failures} of ${checks} checks failed`);
process.exit(failures === 0 ? 0 : 1);
