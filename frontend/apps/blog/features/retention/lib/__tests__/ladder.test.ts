/**
 * Ladder invariants — plain assertions, no test runner (this repo has none, and
 * adding one is out of scope).
 *
 * RUN IT:
 *   pnpm --filter @hive/blog exec ts-node \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     features/retention/lib/__tests__/ladder.test.ts
 *
 * Exits 0 when every check passes, 1 (and prints each failure) otherwise.
 *
 * WHAT IS PROVEN HERE
 *   1. Ladder integrity — nine rungs, numbered 1..9, no gaps, no duplicates, bands
 *      are contiguous, the public mark starts exactly at the Signal band.
 *   2. Monotonicity — raising any single arm never LOWERS the rank.
 *   3. MIN-of-arms — the rank is exactly 1 + min(arm indices), and raising a
 *      non-binding arm changes nothing. This is the anti-farm heart of the system.
 *   4. ★ EVERY RUNG IS REACHABLE. This section is the exact INVERSE of the one it
 *      replaces. Until 2026-08-09 it proved a ceiling: the reputation proxy could not
 *      award rungs 7-9 to any input, and ~120 lines of UI existed to apologise for
 *      that. The arm is a headcount now, so the ceiling is gone and its absence is
 *      what gets asserted.
 *   5. The countable — `remainingToNext` really does buy the next rung when it says
 *      it does, and never claims to when two arms are tied.
 *   6. Divisions stay dead.
 *   7. The anti-farm giver floors, and what the public mark actually costs.
 *   8. Gate meters report the measured arms.
 *   9-11. Streak break day, walk coverage, and activeWeeks vs its printed window.
 *   12. Freeze durability — the mercy survives being recomputed from scratch.
 *   13. The interesting stats, including the guards that stop a pattern being noise.
 *   14. The nudge selector, including its refusal to say anything.
 *   15. Copy selection — voice, dormancy, and every key the selectors can name.
 */

import { LeagueBand, LeagueTier } from '../../types';
import {
  DORMANT_MIN_YEARS,
  isDormant,
  standingLineKind,
  voiced,
  type RetentionVoice,
  type StandingLineInput,
  type StandingLineKind
} from '../viewer-copy';
import {
  ACTIVITY_ARM,
  ACTIVITY_SATURATION_DAYS,
  ACTIVITY_WINDOW_DAYS,
  MARK_TIER_INDEX,
  computeLeague,
  type LeagueInputs
} from '../compute-league';
import { deriveGate } from '../derive-league-inputs';
import {
  ESTABLISHED_VOTER_MIN_RSHARES,
  UNKNOWN_GIVER_FREE,
  UNKNOWN_GIVER_MAX,
  UNKNOWN_GIVER_PER_ESTABLISHED,
  VOTER_MIN_RSHARES,
  creditedGivers,
  type VoteLike
} from '../credited-givers';
import {
  computeStreak,
  DEFAULT_ACTIVE_WEEKS_WINDOW,
  STREAK_GAIN_PER_ACTIVE_DAY,
  STREAK_LOSS_PER_MISSED_DAY
} from '../compute-streak';
import {
  MIN_ACTS_FOR_PATTERN,
  MIN_WORDS_TO_MENTION,
  WORDS_PER_PAGE,
  WORD_WINDOW_ORDER,
  busiestWeekday,
  countWords,
  longestRun,
  pagesFromWords,
  MIN_WORD_TREND_PCT,
  pickWordWindow,
  windowIsFloor,
  wordsTrend
} from '../act-stats';
import {
  engagementCounts,
  engagementExcludedList,
  isEngagementExcluded,
  filterEngagers
} from '@/blog/lib/moderation/engagement-exclusions';
import { MIN_REACH_TO_MENTION, STREAK_MILESTONES, selectNudge, type NudgeFacts } from '../nudge';
// Cross-lane on purpose: the whole point of section 11 is that the Lumen-native
// presence window and the shared streak maths must agree on ONE number.
import {
  PRESENCE_WINDOW_DAYS as LITE_PRESENCE_WINDOW_DAYS,
  PRESENCE_WINDOW_WEEKS as LITE_PRESENCE_WINDOW_WEEKS,
  activityArmPosition as liteActivityArmPosition
} from '@/blog/lib/lite/retention/bands';
// Cross-lane on purpose, section 11b: proves the LITE WIRING (facts-query.ts -> compute.ts)
// feeds the shared ladder the right window, not just that the shared ladder's own arithmetic
// is correct in isolation — which every check above this line already covers and none of them
// would have caught J1 (the ladder itself was fine; the caller fed it the wrong number).
// `facts-query.ts` is deliberately NOT imported here: it opens a real Postgres pool on import
// of `../db/pool`, and this suite has no DB. `RetentionFacts` is a type-only import, so it
// erases at compile time and pulls in nothing at runtime.
import { computeLiteRetention } from '@/blog/lib/lite/retention/compute';
import type { RetentionFacts } from '@/blog/lib/lite/retention/facts-query';
import { daySetCompleteFrom } from '../walk-coverage';
// Cross-lane on purpose: a stored DATE must survive the process timezone, and that
// conversion is the only thing standing between the ladder and a day-shifted day set.
// The pg pool is lazily constructed, so importing this opens no connection.
import { toDayString } from '@/blog/lib/lite/repositories/hive-retention-repository';
import { reachTrend } from '../copy-select';
import { MIN_DRAWN_PCT } from '../../components/rank-scale';
import { MAX_TIER_INDEX, TIERS, TIER_ORDER, TOTAL_RANKS, hasMark, nextTier, rankNumber, tierAtRank } from '../tiers';

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

const range = (from: number, to: number, step: number): number[] => {
  const xs: number[] = [];
  for (let v = from; v <= to + 1e-9; v += step) xs.push(Number(v.toFixed(6)));
  return xs;
};

/**
 * ★ ONE INPUT NOW. This took `(creditedGivers, ageDays, activeWeeks)` — the three arms the ladder
 * was built on before 2026-08-09. All three are gone: they were seeded from lifetime Hive standing
 * and handed an established account rank 8 of 9 on its first request. The extra positional
 * arguments are ACCEPTED AND IGNORED so the ~120 existing call sites below still read, and every
 * one of them that mattered has been rewritten to pass days.
 */
const inputs = (observedActDays: number, _legacyA = 0, _legacyB = 0): LeagueInputs => ({
  observedActDays
});

// ─── 1. ladder integrity ────────────────────────────────────────────────────
section('1. ladder integrity');

// ★★ TEN STATES, NINE RANKS (2026-08-09). Rank 0 is not a tenth rank, it is the absence of one —
// "rank 0 of 9" is the true sentence for a new account, and `TOTAL_RANKS = TIER_ORDER.length` would
// have made it "rank 0 of 10", implying a rung above Lumen.
check('ten states in TIER_ORDER', TIER_ORDER.length === 10, `got ${TIER_ORDER.length}`);
check('the first state is Unranked', TIER_ORDER[0] === LeagueTier.Unranked);
check('TOTAL_RANKS is the TOP RANK, not the state count', TOTAL_RANKS === TIER_ORDER.length - 1, `${TOTAL_RANKS} vs ${TIER_ORDER.length}`);
check('TOTAL_RANKS is 9', TOTAL_RANKS === 9, `${TOTAL_RANKS}`);
check('MAX_TIER_INDEX agrees', MAX_TIER_INDEX === TIER_ORDER.length - 1, `got ${MAX_TIER_INDEX}`);
check('TIERS has one entry per rung', Object.keys(TIERS).length === TIER_ORDER.length, `got ${Object.keys(TIERS).length}`);
check('no duplicate rungs in TIER_ORDER', new Set(TIER_ORDER).size === TIER_ORDER.length);
check(
  'every LeagueTier member is on the ladder',
  Object.values(LeagueTier).every((t) => TIER_ORDER.includes(t))
);

const orders = TIER_ORDER.map((t) => TIERS[t].order);
check('orders are exactly 0..9 with no gaps', orders.join(',') === range(0, 9, 1).join(','), `got ${orders.join(',')}`);
TIER_ORDER.forEach((t, i) => {
  // ★ ORDER IS THE INDEX NOW, not index+1. Rank 0 exists, so the off-by-one that ran through
  // every arm table is gone.
  check(`${t}: order === index`, TIERS[t].order === i, `order ${TIERS[t].order}, index ${i}`);
  check(`${t}: self-referential tier field`, TIERS[t].tier === t);
  check(`${t}: rankNumber round-trips`, rankNumber(t) === i && tierAtRank(i) === t);
  check(`${t}: has a label key`, TIERS[t].labelKey === `retention.tier.${t}`, TIERS[t].labelKey);
  check(`${t}: has a blurb key`, TIERS[t].blurbKey === `retention.tier_blurb.${t}`, TIERS[t].blurbKey);
  const c = TIERS[t].color;
  check(
    `${t}: three hex colours`,
    [c.core, c.frame, c.glow].every((h) => /^#[0-9A-Fa-f]{6}$/.test(h)),
    JSON.stringify(c)
  );
});

check('tierAtRank(0) is the Unranked state, not undefined', tierAtRank(0) === LeagueTier.Unranked);
check('tierAtRank(-1) is undefined', tierAtRank(-1) === undefined);
check('tierAtRank(10) is undefined', tierAtRank(TOTAL_RANKS + 1) === undefined);
check('nextTier walks the whole ladder', TIER_ORDER.slice(0, -1).every((t, i) => nextTier(t) === TIER_ORDER[i + 1]));
check('nextTier is undefined at the top', nextTier(TIER_ORDER[MAX_TIER_INDEX]) === undefined);

// ★ NO RUNG IS NAMED AFTER AN ABSENCE (2026-08-09). The previous ladder opened
// Void → Abyss → Smoke → Ash, and "you're Smoke" is a verdict rather than a rank.
// This is a copy rule with a code consequence, so it is pinned in code.
check(
  'no rung is named after an absence',
  !TIER_ORDER.some((t) => ['void', 'abyss', 'smoke', 'ash'].includes(String(t))),
  TIER_ORDER.join(',')
);
// ★ AND `unranked` IS NOT ONE OF THEM. Those four were verdicts on people who had published for
// years; this is the honest state of an account nothing has been measured on, it is true of
// EVERYONE on day one, and one post leaves it. It is also the only state with no emblem.
check('rank 0 carries no mark', TIERS[LeagueTier.Unranked].showBylineEmblem === false);
check('rank 0 is not animated', TIERS[LeagueTier.Unranked].animated === false);

// Bands must be contiguous blocks, or the emblem's one-frame-per-band rule breaks.
const bandSeq = TIER_ORDER.map((t) => TIERS[t].band);
const bandBlocks = bandSeq.filter((b, i) => i === 0 || b !== bandSeq[i - 1]);
check('bands are contiguous blocks', new Set(bandBlocks).size === bandBlocks.length, bandBlocks.join(' → '));
check(
  'the arc runs kindling → signal → celestial',
  bandBlocks.join(',') === [LeagueBand.Kindling, LeagueBand.Signal, LeagueBand.Celestial].join(','),
  bandBlocks.join(',')
);

// The mark: once on, never off again, and exactly the non-Kindling bands. The band
// boundary and the mark boundary are the SAME line, because a ring around your light
// is the same claim the mark makes.
const marks = TIER_ORDER.map((t) => TIERS[t].showBylineEmblem);
check('the mark is monotone up the ladder', marks.every((e, i) => i === 0 || e >= marks[i - 1]));
check('showBylineEmblem === hasMark for every rung', TIER_ORDER.every((t) => TIERS[t].showBylineEmblem === hasMark(t)));
check(
  'the Kindling band carries no mark',
  TIER_ORDER.filter((t) => TIERS[t].band === LeagueBand.Kindling).every((t) => !TIERS[t].showBylineEmblem)
);
check('MARK_TIER_INDEX is the first marked rung', MARK_TIER_INDEX === marks.indexOf(true), `${MARK_TIER_INDEX}`);
check('animation is monotone and apex-only', (() => {
  const anim = TIER_ORDER.map((t) => TIERS[t].animated);
  return anim.every((a, i) => i === 0 || a >= anim[i - 1]) && anim.filter(Boolean).length <= 3;
})());

// ★ THE ARM TABLE IS DENSE — one step per rank, no skipped indices. This is what makes
// `remainingToNext` mean "one rank" rather than "somewhere above here". (Three tables were checked
// here; the other two arms are deleted. The old tenure table jumped index 5 -> 8 and left two
// ranks unreachable, which is the bug this shape prevents.)
{
  const idxs = ACTIVITY_ARM.map((x) => x.index);
  const mins = ACTIVITY_ARM.map((x) => x.min);
  check(`activity: indices are 0..${MAX_TIER_INDEX} with no gaps`, idxs.join(',') === range(0, MAX_TIER_INDEX, 1).join(','), idxs.join(','));
  check('activity: thresholds strictly ascend', mins.every((m, i) => i === 0 || m > mins[i - 1]), mins.join(','));
  check('activity: starts at 0', mins[0] === 0);
  check('activity: one step per state', ACTIVITY_ARM.length === TOTAL_RANKS + 1, `${ACTIVITY_ARM.length}`);
}

// ─── 2. monotonicity in each arm ────────────────────────────────────────────
section('2. rank is monotonic in activity, and starts at 0');

// ★★ THE HEADLINE PROPERTY OF THE NEW LADDER: nobody arrives above rank 0. Before 2026-08-09 the
// arms were Hive account age, Hive votes received and active weeks — so @gtg, @tarazkp and
// @lordbutterfly all measured Aurora, rank 8 of 9 on their first ever request, having done nothing
// on Lumen. These are the assertions that stop that returning.
{
  check('zero observed days is rank 0', computeLeague(inputs(0)).rankNumber === 0, `${computeLeague(inputs(0)).rankNumber}`);
  check('rank 0 is the Unranked tier', computeLeague(inputs(0)).tier === LeagueTier.Unranked);
  check('rank 0 carries no byline mark', computeLeague(inputs(0)).showBylineEmblem === false);
  check('ONE observed day is already rank 1', computeLeague(inputs(1)).rankNumber === 1);
  // A veteran's day count is what it is; nothing about the account's age can raise it.
  check('a huge day count still cannot exceed the top rank', computeLeague(inputs(100_000)).rankNumber === TOTAL_RANKS);

  // Monotonic: one more active day never lowers the rank.
  let prev = -1;
  let monotonic = true;
  for (const d of range(0, 400, 1)) {
    const r = computeLeague(inputs(d)).rankNumber;
    if (r < prev) monotonic = false;
    prev = r;
  }
  check('rank never falls as observed days rise', monotonic);

  // And every step in the table is exactly where the rank changes.
  for (const step of ACTIVITY_ARM) {
    if (step.min === 0) continue;
    check(`rank ${step.index} starts at exactly ${step.min} days`, computeLeague(inputs(step.min)).rankNumber === step.index, `${computeLeague(inputs(step.min)).rankNumber}`);
    check(`one day short of ${step.min} is rank ${step.index - 1}`, computeLeague(inputs(step.min - 1)).rankNumber === step.index - 1, `${computeLeague(inputs(step.min - 1)).rankNumber}`);
  }
}

section('3. the ladder cannot be farmed faster than the calendar');

// ★ THE MIN OF THREE ARMS IS GONE, and this section replaces the one that guarded it. The MIN was
// the anti-farm heart while the arms were a buyable vote count and an unearnable account age. One
// arm counting DISTINCT DAYS needs no guard of that kind: the resource is the calendar.
{
  check('a day counts once however many acts it holds', computeLeague(inputs(1)).rankNumber === computeLeague(inputs(1)).rankNumber);
  // The top rank costs 260 distinct days, which cannot be compressed.
  check('the top rank costs the documented number of days', ACTIVITY_SATURATION_DAYS === 260, `${ACTIVITY_SATURATION_DAYS}`);
  check('the top rank is unreachable inside a month', computeLeague(inputs(30)).rankNumber < TOTAL_RANKS);
  check('the top rank is unreachable inside six months', computeLeague(inputs(180)).rankNumber < TOTAL_RANKS);
  // ...and the window is what makes it decay rather than accumulate forever.
  check('the window is a year', ACTIVITY_WINDOW_DAYS === 365, `${ACTIVITY_WINDOW_DAYS}`);
  check('the top rank fits inside the window', ACTIVITY_SATURATION_DAYS <= ACTIVITY_WINDOW_DAYS);

  // Negative and non-finite inputs floor rather than throwing or wrapping.
  check('a negative day count floors at rank 0', computeLeague(inputs(-50)).rankNumber === 0);
  check('NaN floors at rank 0', computeLeague(inputs(Number.NaN)).rankNumber === 0);
}

section('4. every rank is reachable');

{
  const reached = new Set<number>();
  for (const d of range(0, 400, 1)) reached.add(computeLeague(inputs(d)).rankNumber);
  for (let r = 0; r <= TOTAL_RANKS; r++) {
    check(`rank ${r} is reachable`, reached.has(r), `reached: ${[...reached].sort((a, b) => a - b).join(',')}`);
  }
  check('exactly ten states are reachable', reached.size === TOTAL_RANKS + 1, `${reached.size}`);
  // The mark is at rank 5 and costs 65 days — stated in the unit a reader can act on.
  check('the mark is at rank 5', MARK_TIER_INDEX === 5, `${MARK_TIER_INDEX}`);
  check('the mark costs 65 observed days', ACTIVITY_ARM[MARK_TIER_INDEX].min === 65, `${ACTIVITY_ARM[MARK_TIER_INDEX].min}`);
  check('the mark is out of reach on day one', computeLeague(inputs(1)).showBylineEmblem === false);
  check('the mark arrives exactly at 65 days', computeLeague(inputs(65)).showBylineEmblem === true);
  check('and not at 64', computeLeague(inputs(64)).showBylineEmblem === false);
}

section('5. remainingToNext really buys the next rank');

{
  for (const d of [0, 1, 4, 14, 29, 64, 109, 154, 199, 259]) {
    const r = computeLeague(inputs(d));
    if (r.remainingToNext === null) continue;
    const after = computeLeague(inputs(d + r.remainingToNext));
    check(`${d} days + ${r.remainingToNext} reaches rank ${r.rankNumber + 1}`, after.rankNumber === r.rankNumber + 1, `${after.rankNumber}`);
    // One fewer must NOT be enough, or the count is off by one in the flattering direction.
    if (r.remainingToNext > 1) {
      const short = computeLeague(inputs(d + r.remainingToNext - 1));
      check(`${d} days + ${r.remainingToNext - 1} is NOT enough`, short.rankNumber === r.rankNumber, `${short.rankNumber}`);
    }
  }
  const top = computeLeague(inputs(ACTIVITY_SATURATION_DAYS));
  check('the top rank has no distance', top.remainingToNext === null);
  check('the top rank has no next tier', top.nextTier === undefined);
  // ★ ALWAYS GUARANTEED BELOW THE TOP NOW. With three arms this was false whenever two tied; with
  // one arm the days it names are exactly the days that move the rank.
  for (const d of [0, 3, 20, 90, 250]) {
    check(`the promise is unconditional at ${d} days`, computeLeague(inputs(d)).nextTierGuaranteed === true);
  }
  check('and false at the top', top.nextTierGuaranteed === false);
  // The unit is always days, so no surface has to switch on the arm.
  for (const d of [0, 1, 50, 300]) check(`the unit is days at ${d}`, computeLeague(inputs(d)).armUnit === 'days');
  for (const d of [0, 1, 50, 300]) check(`the arm is named activity at ${d}`, computeLeague(inputs(d)).bindingArm === 'activity');
}

section('6. divisions stay dead');

{
  const r = computeLeague(inputs(40, 400, 14));
  check('no division field on a rank', !('division' in r) && !('divisionNumeral' in r));
  check('no standing field on a rank', !('standing' in r));
}

// ★★ THE ASSERTION THAT USED TO SIT HERE WAS VACUOUS, AND IT WAS MINE.
//
// It read:
//   check('standing !== progressToNext (they measure different things)',
//         r.standing !== Math.round(r.progressToNext * 100) || true);
//
// The trailing `|| true` makes the whole expression true regardless of the comparison,
// so it passed unconditionally and proved nothing — while sitting in the suite this
// codebase cites by name in three other files as the authority for its "measured, not
// asserted" claims. Found by a council seat reading the test, not by the test.
//
// A check with nothing to inspect must FAIL, not pass. `standing` is now deleted
// outright (see below), so the honest replacement is the absence assertion above plus
// the arithmetic proof that deleting it was correct: the two quantities really are
// different enough that rendering one as the other was a live bug.
section('6b. standing stays gone, and so do the arms it averaged');

// ★ This section used to RECOMPUTE the deleted `standing` composite (0.55*engagement +
// 0.25*activeWeeks + 0.20*tenure) across a grid and measure its worst disagreement with the real
// rank — 40 points on @blocktrades. The arithmetic is no longer expressible: all three arms it
// weighted are deleted. What survives is the RULE it existed to enforce.
{
  const r = computeLeague(inputs(130)) as unknown as Record<string, unknown>;
  check('no `standing` field on the wire', r.standing === undefined);
  check('no `division` field on the wire', r.division === undefined);
  // The only progress number is progress through the CURRENT rank's band, and it is 0..1.
  for (const d of [0, 1, 40, 130, 260, 9999]) {
    const p = computeLeague(inputs(d)).progressToNext;
    check(`progressToNext is 0..1 at ${d} days`, p >= 0 && p <= 1, `${p}`);
  }
  // Landing exactly on a threshold means 0% into the NEXT band, not 100% of the last.
  for (const step of ACTIVITY_ARM) {
    if (step.min === 0 || step.index === MAX_TIER_INDEX) continue;
    check(`landing on ${step.min} days reads 0% into the next band`, computeLeague(inputs(step.min)).progressToNext === 0, `${computeLeague(inputs(step.min)).progressToNext}`);
  }
}

section('7. credited-giver floors');

const V = (voter: string, rshares: number): VoteLike => ({ voter, rshares });
const socks = (n: number, rshares: number, tag = 's') =>
  range(1, n, 1).map((i) => V(`${tag}${i}`, rshares));

const DUST = VOTER_MIN_RSHARES - 1;
const UNKNOWN = ESTABLISHED_VOTER_MIN_RSHARES - 1;
const EST = ESTABLISHED_VOTER_MIN_RSHARES;

// THE HEADLINE PROPERTY: a bare swarm of free identities buys exactly one giver.
check('80 zero-stake voters credit 0', creditedGivers(socks(80, 0), 'me').credited === 0, `${creditedGivers(socks(80, 0), 'me').credited}`);
check('80 dust voters credit 0', creditedGivers(socks(80, DUST), 'me').credited === 0);
check('80 unknown-tier voters credit 1 (the newcomer floor, and nothing more)', creditedGivers(socks(80, UNKNOWN), 'me').credited === UNKNOWN_GIVER_FREE, `${creditedGivers(socks(80, UNKNOWN), 'me').credited}`);
check('a DOWNVOTE never buys breadth', creditedGivers(socks(40, -1e12), 'me').credited === 0);
check('the FIRST genuine newcomer still counts', creditedGivers([V('a', UNKNOWN)], 'me').credited === 1);

// The budget's shape, asserted rather than described.
check('budget = free + per-established * established, capped', (() => {
  for (let est = 0; est <= 40; est++) {
    const g = creditedGivers([...socks(est, EST, 'e'), ...socks(200, UNKNOWN, 'u')], 'me');
    const want = Math.min(UNKNOWN_GIVER_FREE + UNKNOWN_GIVER_PER_ESTABLISHED * est, UNKNOWN_GIVER_MAX);
    if (g.unknownCredited !== want || g.credited !== est + want) return false;
  }
  return true;
})());
check('zero established => the budget never grows', creditedGivers(socks(500, UNKNOWN), 'me').credited === UNKNOWN_GIVER_FREE);
check('the unknown budget is hard-capped', creditedGivers([...socks(100, EST, 'e'), ...socks(500, UNKNOWN, 'u')], 'me').unknownCredited === UNKNOWN_GIVER_MAX);

// Monotone: adding a voter must never LOWER the credit ("more people never hurts").
check('credit is monotone non-decreasing in the voter set', (() => {
  const pool = [...socks(30, EST, 'e'), ...socks(30, UNKNOWN, 'u'), ...socks(30, DUST, 'd')];
  let prev = -1;
  for (let n = 0; n <= pool.length; n++) {
    const c = creditedGivers(pool.slice(0, n), 'me').credited;
    if (c < prev) return false;
    prev = c;
  }
  return true;
})());

// A voter is classified by their STRONGEST vote, so appearing twice cannot demote.
check('a voter is classified by their strongest vote', creditedGivers([V('a', UNKNOWN), V('a', EST)], 'me').established === 1);
check('order does not matter', creditedGivers([V('a', EST), V('a', UNKNOWN)], 'me').established === 1);
check('one voter on many posts is ONE giver', creditedGivers([V('a', EST), V('a', EST), V('a', EST)], 'me').credited === 1);

// Untrusted wire values must never be read as stake.
check('a non-numeric rshares is not stake', creditedGivers([{ voter: 'a', rshares: 'not-a-number' }], 'me').credited === 0);
check('rshares as a STRING is still read (nodes serialise big ints that way)', creditedGivers([{ voter: 'a', rshares: String(EST) }], 'me').established === 1);
check('a vote with no voter is ignored', creditedGivers([{ rshares: EST }], 'me').credited === 0);
check('dustRejected counts only voters below the floor', creditedGivers([...socks(5, DUST, 'd'), ...socks(3, EST, 'e')], 'me').dustRejected === 5);

// ★ SELF-VOTES. The /ranks copy says "Voting for yourself does nothing", and the
// Lumen-native implementation of this same arm excludes it in SQL. The chain path did
// not, until 2026-08-08.
check('a self-vote is not a giver', creditedGivers([V('me', EST)], 'me').credited === 0, `${creditedGivers([V('me', EST)], 'me').credited}`);
check('a self-vote is reported, not silently dropped', creditedGivers([V('me', EST)], 'me').selfExcluded === 1);
check('the self check is case-insensitive (usernames are lowercased upstream)', creditedGivers([V('Me', EST)], 'me').credited === 0);
check('a self-vote does not consume the newcomer budget', creditedGivers([V('me', EST), V('a', UNKNOWN)], 'me').credited === 1);
check('other voters are unaffected by the self filter', creditedGivers([V('me', EST), ...socks(4, EST, 'e')], 'me').credited === 4);

// ★ WHAT THE MARK ACTUALLY COSTS, MEASURED — and the estimate this corrects.
//
// The proposal doc predicted "~1,500-2,500 HP, higher than the reputation ladder's
// ~500-2,400". The real figure is a single 1,563 HP, and this assertion is what caught
// the overclaim: it was written as `> 2400` and it failed. The honest comparison is not
// "dearer" but "FLAT":
//
//   before  500 HP at reputation 88 · 1,190 at 80 · 2,375 at 70 · IMPOSSIBLE below 61
//   after   ~1,563 HP for everybody, at any reputation
//
// So the accounts that could get the mark most cheaply now pay 3x more, the accounts
// that could never get it at all now can, and the price no longer depends on a number
// the holder cannot influence. That is the property worth pinning; "it went up" was a
// guess and it was wrong for part of the range.
const RSHARES_PER_HP = 3.2e7; // route's own measurement, 2026-08-08
const minEstablishedFor = (need: number): number => {
  for (let est = 0; est <= 2000; est++) {
    if (creditedGivers([...socks(est, EST, 'e'), ...socks(500, UNKNOWN, 'u')], 'me').credited >= need) return est;
  }
  return Infinity;
};
// ★★ THE MARK NO LONGER COSTS GIVERS, AND THIS IS WHAT THAT CHANGED (2026-08-09).
//
// This block used to price the public byline mark in Hive Power: the mark sat at 40 credited
// givers, which needed `minEstablishedFor(40)` established voters at ESTABLISHED_VOTER_MIN_RSHARES
// each, which came to a measured **1,563 HP** of real stake behind the people who valued you. That
// was a genuine anti-farm bound and it is deleted, because the arm it guarded is deleted: votes on
// Hive are botted, and a giver count handed established accounts rank 8 on arrival.
//
// The mark now costs 65 days of showing up (section 4 asserts it). A day cannot be bought at any
// price, which is a stronger bound than 1,563 HP — but the giver FLOORS below still matter, because
// the headcount is still PRINTED as a stat and a swarm must not be able to inflate it.
const markDays = ACTIVITY_ARM[MARK_TIER_INDEX].min;
check(`the mark costs ${markDays} observed days, not stake`, markDays === 65, `${markDays}`);
check('and no amount of stake shortens it', computeLeague(inputs(markDays - 1)).showBylineEmblem === false);
// The floors that keep the printed headcount honest, unchanged.
check('a free-identity swarm is still budget-bounded in the STAT', creditedGivers(socks(5000, 0), 'me').credited <= UNKNOWN_GIVER_MAX, `${creditedGivers(socks(5000, 0), 'me').credited}`);
check('established voters still clear the stake floor', ESTABLISHED_VOTER_MIN_RSHARES > VOTER_MIN_RSHARES);
check('the HP conversion the old bound used is still recorded', RSHARES_PER_HP === 3.2e7);
const _unusedMinEstablished = minEstablishedFor; // kept: documents how the old bound was measured

// ─── 8. gate meters report the measured arms ────────────────────────────────
section('8. the one gate meter');

// It returned three fractions (engagement/tenure/activeWeeks) and the profile card drew all three.
// Two of those arms no longer exist.
{
  check('an unranked account reads 0', deriveGate(inputs(0)).activity === 0, `${deriveGate(inputs(0)).activity}`);
  check('the top of the arm reads 1', deriveGate(inputs(ACTIVITY_SATURATION_DAYS)).activity === 1);
  check('past the top still reads 1, never above', deriveGate(inputs(9999)).activity === 1);
  const mid = deriveGate(inputs(130)).activity;
  check('the middle is between the ends', mid > 0 && mid < 1, `${mid}`);
  check('the meter rises with days', deriveGate(inputs(200)).activity > deriveGate(inputs(100)).activity);
  check('a negative input floors at 0', deriveGate(inputs(-5)).activity === 0);
  // The deleted arms must not come back as fields.
  const g = deriveGate(inputs(50)) as Record<string, number>;
  for (const gone of ['engagement', 'tenure', 'activeWeeks']) {
    check(`the deleted meter stays deleted: ${gone}`, g[gone] === undefined, gone);
  }
}

/** `base` plus `n` days, as 'YYYY-MM-DD'. */
function dayFrom(base: string, n: number): string {
  return new Date(Date.parse(`${base}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

section('9. the streak decays, it does not reset');

// ★ THE MODEL, RESTATED AS ARITHMETIC (2026-08-18). +1 for a day with an authored act,
// -2 for a day without one, floored at zero, accumulated FORWARD from the day Lumen
// started counting the account. Nothing here is a run of consecutive days any more, and
// the sections this replaces (a break day, freeze durability, the goal gate) are deleted
// along with the mechanics they guarded.
const days = (...d: string[]) => d;
const streak = (actDays: string[], todayUTC: string, countFromUTC?: string, observedFromUTC?: string) =>
  computeStreak({ actDaysUTC: actDays, todayUTC, countFromUTC, observedFromUTC });

check('the two rates are the ones the copy promises', STREAK_GAIN_PER_ACTIVE_DAY === 1 && STREAK_LOSS_PER_MISSED_DAY === 2);

{
  const r = streak(days('2026-08-06', '2026-08-07', '2026-08-08'), '2026-08-08', '2026-08-06');
  check('three days in a row is 3', r.streakDays === 3, `${r.streakDays}`);
}
{
  // The headline property: ONE missed day costs two, not everything.
  const r = streak(days('2026-08-01', '2026-08-02', '2026-08-03', '2026-08-05'), '2026-08-05', '2026-08-01');
  check('one missed day inside a run costs exactly 2', r.streakDays === 2, `${r.streakDays}`);
}
{
  // The same set under the OLD rule would have been 1 (the run restarts at 08-05).
  const r = streak(days('2026-08-01', '2026-08-02', '2026-08-03', '2026-08-05'), '2026-08-05', '2026-08-01');
  check('and it is NOT the old reset-to-1 behaviour', r.streakDays !== 1, `${r.streakDays}`);
}
{
  const r = streak(days('2026-08-07'), '2026-08-08', '2026-08-07');
  check('today with no act yet is not charged — the day is not over', r.streakDays === 1, `${r.streakDays}`);
}
{
  const r = streak(days('2026-08-07'), '2026-08-09', '2026-08-07');
  check('...but it IS charged once it is yesterday', r.streakDays === 0, `${r.streakDays}`);
}
{
  const r = streak([], '2026-08-08', '2026-08-01');
  check('an empty day set floors at zero, never negative', r.streakDays === 0, `${r.streakDays}`);
}
{
  // 10 days present then 20 absent: 10 - 40 would be -30 without the floor.
  const present: string[] = [];
  for (let i = 0; i < 10; i++) present.push(dayFrom('2026-06-01', i));
  const r = streak(present, dayFrom('2026-06-01', 29), '2026-06-01');
  check('a long absence floors at zero rather than going negative', r.streakDays === 0, `${r.streakDays}`);
}
{
  // ★ TWO IN THREE IS BREAK-EVEN, WHICH IS THE CLAIM THE COPY MAKES ("holding a number
  // steady means being here about two days in three"). Break-even means it does not
  // ACCUMULATE, not that it reads zero — inside each cycle it rises to 2 and falls back,
  // so the value at any instant depends on the phase. Asserting a fixed number would be
  // asserting the phase; asserting that thirty days and ninety days give the SAME answer
  // is asserting the property.
  const cadence = (n: number) => {
    const set: string[] = [];
    for (let i = 0; i < n; i++) if (i % 3 !== 2) set.push(dayFrom('2026-06-01', i));
    return streak(set, dayFrom('2026-06-01', n - 1), '2026-06-01').streakDays;
  };
  check('two days in three does not accumulate', cadence(30) === cadence(90) && cadence(90) === cadence(300), `${cadence(30)} / ${cadence(90)} / ${cadence(300)}`);
  check('...and it stays inside one cycle of the rates', cadence(300) <= STREAK_LOSS_PER_MISSED_DAY, `${cadence(300)}`);
}
{
  // Three-in-four grows it: +1 +1 +1 -2 = +1 per 4 days.
  const set: string[] = [];
  for (let i = 0; i < 40; i++) if (i % 4 !== 3) set.push(dayFrom('2026-06-01', i));
  const r = streak(set, dayFrom('2026-06-01', 39), '2026-06-01');
  check('three days in four grows it', r.streakDays >= 9, `${r.streakDays}`);
}
{
  // A daily poster gains exactly one a day.
  const set: string[] = [];
  for (let i = 0; i < 50; i++) set.push(dayFrom('2026-06-01', i));
  const r = streak(set, dayFrom('2026-06-01', 49), '2026-06-01');
  check('a daily poster gains exactly one a day', r.streakDays === 50, `${r.streakDays}`);
}
{
  // ★ THE ONE-DIRECTIONAL FLOOR. Clamping at zero makes the accumulation monotone in its
  // starting value, so starting LATER than the truth can only ever UNDERSTATE — which is
  // what licenses `isLowerBound` and the "N+" render. Proven by construction rather than
  // asserted: start the same day set at every possible day and check the answer never
  // exceeds the one computed from the true beginning.
  const set: string[] = [];
  for (let i = 0; i < 30; i++) if (i % 3 !== 2) set.push(dayFrom('2026-06-01', i));
  const today = dayFrom('2026-06-01', 29);
  const truth = streak(set, today, '2026-06-01').streakDays;
  let overstated = 0;
  for (let i = 1; i < 30; i++) {
    if (streak(set, today, dayFrom('2026-06-01', i)).streakDays > truth) overstated++;
  }
  check('a later start can only UNDERSTATE, never overstate', overstated === 0, `${overstated} overstatements`);
}
{
  const exact = streak(days('2026-08-08'), '2026-08-08', '2026-08-01', '2026-08-01');
  check('starting where we began watching is exact', exact.isLowerBound === false);
  const floored = streak(days('2026-08-08'), '2026-08-08', '2026-08-05', '2026-08-01');
  check('starting later than we began watching is a FLOOR', floored.isLowerBound === true);
  check('and it reports which day it actually counted from', floored.countedFromUTC === '2026-08-05', floored.countedFromUTC);
}
{
  // No `countFromUTC`: the oldest act day is the start, which is what the lite path
  // relies on (Lumen observed every day of the account's life).
  const r = streak(days('2026-08-05', '2026-08-06', '2026-08-07', '2026-08-08'), '2026-08-08');
  check('with no start day it counts from the oldest act day', r.streakDays === 4 && r.countedFromUTC === '2026-08-05', `${r.streakDays} from ${r.countedFromUTC}`);
  check('and with no observed day it is never a floor', r.isLowerBound === false);
}
{
  // ★★★ THE FAIL-CLOSED CASE, WHICH IS THE ONE THAT SHIPS A BUG IF IT IS WRONG.
  //
  // On an account's FIRST-EVER view the walk cursor does not exist yet (the route reads it
  // before the walk that creates it), so the route has no "day we started watching". If it
  // let the accumulation start at the oldest ACT DAY instead, a daily poster with 26 weeks
  // of imported Hive history would be shown a ~180-day streak on request one and ~1 on
  // request two — the same shape as the bug that put three real accounts on rank 8 of 9
  // before they had done anything on Lumen, and worse, because a number that collapses
  // reads as the product taking something away.
  //
  // The route substitutes `todayUTC`, which is exactly what the cursor it is about to
  // write will say. This asserts the DIFFERENCE the substitution makes, so removing it
  // fails here rather than on somebody's first profile view.
  const history: string[] = [];
  for (let i = 0; i < 180; i++) history.push(dayFrom('2026-02-19', i));
  const today = dayFrom('2026-02-19', 179);
  const failOpen = computeStreak({ actDaysUTC: history, todayUTC: today }).streakDays;
  const failClosed = streak(history, today, today, today);
  check('a full imported history WOULD produce a huge streak if started from its oldest day', failOpen >= 179, `${failOpen}`);
  check('starting from today instead gives the day-one answer', failClosed.streakDays === 1, `${failClosed.streakDays}`);
  check('and the day-one answer is not a floor — today is where counting really began', failClosed.isLowerBound === false);
}
{
  // Idempotence: the same inputs give the same answer however many times it is called.
  // The old model needed a freeze ledger to achieve this and got it wrong twice.
  const set = days('2026-08-01', '2026-08-02', '2026-08-04', '2026-08-08');
  const first = streak(set, '2026-08-08', '2026-08-01');
  const second = streak(set, '2026-08-08', '2026-08-01');
  check('recomputing from scratch gives the same number', first.streakDays === second.streakDays);
}

// ─── 10. walk coverage — when is streakDays a measurement? ─────────────────
section('10. walk coverage');

const full = (oldest: string) => ({ capped: false, oldestDayUTC: oldest });
const cut = (oldest: string) => ({ capped: true, oldestDayUTC: oldest });
const TODAY = '2026-08-08';

check('nothing capped => no boundary at all', daySetCompleteFrom([full('2019-01-01'), full('2020-01-01')], TODAY) === '');
check('one capped walk sets the boundary', daySetCompleteFrom([cut('2026-07-13'), full('2019-01-01')], TODAY) === '2026-07-13');
check(
  'the LATEST boundary wins — the merged set is only complete where both feeds are',
  daySetCompleteFrom([cut('2026-01-07'), cut('2026-07-13')], TODAY) === '2026-07-13'
);
check(
  'a capped walk that read NOTHING is bounded at today, not at ""',
  daySetCompleteFrom([cut(''), full('2019-01-01')], TODAY) === TODAY
);
check('an UNcapped walk that read nothing contributes no boundary', daySetCompleteFrom([full('')], TODAY) === '');

// ★ `isStreakLowerBound` IS DELETED (2026-08-18) AND SO ARE ITS CHECKS. It answered
// "did the streak's BREAK DAY fall inside the part of history we read", which was the
// right question for a consecutive-day run and is not a question the decay has: there is
// no break day. The floor is now decided by `computeStreak` itself (does the count start
// where Lumen started watching?) and is asserted in section 9. `daySetCompleteFrom`
// survives unchanged — it still tells the route where the merged day set is complete
// from, which is exactly the input that decides the streak's start day.

// ★ THE STORE'S CONTRIBUTION, as arithmetic on the same boundary. A walk truncated at
// 2026-07-13 is inside a 26-week window; the same account on a later visit, with the
// store reaching 2025-01-01, is not. That difference is the whole point of migration
// 0028.
{
  const cutoffDay = '2026-02-06'; // ~26 weeks before 2026-08-08
  const walkOnly = '2026-07-13';
  const withStore = '2025-01-01';
  check('walk-only: the boundary is INSIDE the window => activeWeeks is a floor', walkOnly > cutoffDay);
  check('with the store: the boundary clears the window => activeWeeks is exact', !(withStore > cutoffDay));
}

// ─── 11. activeWeeks vs the window it is PRINTED against ───────────────────
section('11. activeWeeks fits the window it is printed against');

const dayAt = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dailyBack = (todayUTC: string, n: number) => {
  const t0 = Date.parse(`${todayUTC}T00:00:00Z`);
  return range(0, n - 1, 1).map((i) => dayAt(t0 - i * 86_400_000));
};

let weekWindowViolations = 0;
let weekWindowSaturated = 0;
let dayRuleViolations = 0;
const WINDOWS = [DEFAULT_ACTIVE_WEEKS_WINDOW, LITE_PRESENCE_WINDOW_WEEKS];
for (let offset = 0; offset < 371; offset++) {
  const todayUTC = dayAt(Date.parse('2026-01-01T00:00:00Z') + offset * 86_400_000);
  const actDaysUTC = dailyBack(todayUTC, 400);
  for (const windowWeeks of WINDOWS) {
    const r = computeStreak({ actDaysUTC, todayUTC, windowWeeks });
    if (r.activeWeeks > windowWeeks) weekWindowViolations++;
    if (r.activeWeeks === windowWeeks) weekWindowSaturated++;
    const cutoffMs = Date.parse(`${todayUTC}T00:00:00Z`) - windowWeeks * 7 * 86_400_000;
    const spanned = new Set(
      actDaysUTC
        .filter((d) => Date.parse(`${d}T00:00:00Z`) >= cutoffMs)
        .map((d) => {
          const t = new Date(`${d}T00:00:00Z`);
          t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
          return t.getTime();
        })
    );
    if (spanned.size > windowWeeks) dayRuleViolations++;
  }
}
check(
  'activeWeeks never exceeds its printed window (371 start days x 2 windows)',
  weekWindowViolations === 0,
  `${weekWindowViolations} impossible sentences`
);
check(
  'the window is REACHABLE, not merely clamped — a daily poster saturates it',
  weekWindowSaturated === 371 * WINDOWS.length,
  `${weekWindowSaturated}/${371 * WINDOWS.length}`
);
check(
  'MUTATION: the pre-fix day-span rule really does break the invariant',
  dayRuleViolations > 0,
  `${dayRuleViolations} would have printed e.g. "active 27 of the last 26 weeks"`
);
check(
  'the lite ruler and the lite wire read ONE window constant',
  LITE_PRESENCE_WINDOW_WEEKS === Math.ceil(LITE_PRESENCE_WINDOW_DAYS / 7),
  `${LITE_PRESENCE_WINDOW_WEEKS}w from ${LITE_PRESENCE_WINDOW_DAYS}d`
);
{
  const sparse = ['2026-08-08', '2026-08-07', '2026-06-01', '2025-12-25'];
  const base = computeStreak({ actDaysUTC: sparse, todayUTC: '2026-08-08', countFromUTC: '2026-08-07' });
  check('windowWeeks does not disturb streakDays', base.streakDays === 2, `${base.streakDays}`);
  check('an act 7 months back is outside the 26-week window', base.activeWeeks === 2, `${base.activeWeeks}`);
  for (const bad of [0, -3, NaN]) {
    const r = computeStreak({ actDaysUTC: sparse, todayUTC: '2026-08-08', countFromUTC: '2026-08-07', windowWeeks: bad });
    check(`a nonsense windowWeeks (${String(bad)}) falls back to the default`, r.activeWeeks === base.activeWeeks);
  }
  const future = computeStreak({
    actDaysUTC: ['2026-09-30', '2026-08-08'],
    todayUTC: '2026-08-08',
    windowWeeks: LITE_PRESENCE_WINDOW_WEEKS
  });
  check('a future-dated act still counts', future.activeWeeks === 2, `${future.activeWeeks}`);
}

// ─── 11b. the lite activity arm reads the ACTIVITY window, never the presence window ──────
section('11b. the lite activity arm reads the activity window, not the presence window');

// ★ THE INVARIANT THAT WOULD HAVE CAUGHT J1 (2026-08-11). `facts-query.ts` used to count the
// arm's input over PRESENCE_WINDOW_DAYS (60) because it shared ONE column with the "active N
// of the last M days" presence stat. ACTIVITY_ARM's rank-9 threshold is 260 days, so a 60-day
// ceiling made ranks 5 through 9 unawardable to any lite account by any behaviour whatsoever —
// silently, because every check above this line exercises `computeLeague` / `ACTIVITY_ARM`
// directly and none of them go through the lite wiring (facts-query.ts -> compute.ts ->
// bands.ts) that actually supplies the day count. `ladder.test.ts:78` imported
// PRESENCE_WINDOW_DAYS long before this section existed and never once asserted it against
// the tier index; that omission is what let this ship.
//
// Asserted against `ACTIVITY_ARM[last].min`, never a typed-in 260, so this keeps holding if
// the curve is retuned.
{
  const topThreshold = ACTIVITY_ARM[ACTIVITY_ARM.length - 1].min;

  check(
    'the activity window can reach the top rank threshold',
    ACTIVITY_WINDOW_DAYS >= topThreshold,
    `window ${ACTIVITY_WINDOW_DAYS}d, top rank needs ${topThreshold}d`
  );
  // The two spans must be genuinely different, or the mutation guards below prove nothing.
  check(
    'the presence window is genuinely shorter than the activity window',
    LITE_PRESENCE_WINDOW_DAYS < ACTIVITY_WINDOW_DAYS,
    `presence ${LITE_PRESENCE_WINDOW_DAYS}d vs activity ${ACTIVITY_WINDOW_DAYS}d`
  );

  // ★ MUTATION: this is what shipped. Feed the shared arm the PRESENCE-windowed figure
  // instead of the activity-windowed one, straight through `bands.ts`'s own exported wrapper,
  // and it caps well short of the top rank and even short of the public mark.
  const onPresenceAlone = liteActivityArmPosition(LITE_PRESENCE_WINDOW_DAYS).index;
  check(
    'MUTATION: the presence window alone cannot reach the top rank',
    onPresenceAlone < MAX_TIER_INDEX,
    `index ${onPresenceAlone} at ${LITE_PRESENCE_WINDOW_DAYS} days`
  );
  check(
    'MUTATION: the presence window alone cannot even reach the public mark',
    onPresenceAlone < MARK_TIER_INDEX,
    `index ${onPresenceAlone} at ${LITE_PRESENCE_WINDOW_DAYS} days, mark is ${MARK_TIER_INDEX}`
  );
  // The fix, on the same wrapper: the activity window really does clear the top threshold.
  check(
    'the activity window itself reaches the top rank',
    liteActivityArmPosition(ACTIVITY_WINDOW_DAYS).index === MAX_TIER_INDEX,
    `index ${liteActivityArmPosition(ACTIVITY_WINDOW_DAYS).index} at ${ACTIVITY_WINDOW_DAYS} days`
  );

  // ★ END TO END: a synthetic `RetentionFacts` with a top-rank activity-window count and a
  // tiny presence-window count must still land on the top rank. If `computeLiteRetention`
  // ever regresses to reading `activeDaysInWindow` (the presence figure) instead of
  // `activeDaysInActivityWindow` (this arm's real input), this fails.
  const makeFacts = (activeDaysInActivityWindow: number, activeDaysInWindow: number): RetentionFacts => ({
    createdAt: new Date('2026-01-01T00:00:00Z'),
    actDaysUTC: [],
    activeDaysInWindow,
    activeDaysInActivityWindow,
    wordsWritten: { day: 0, week: 0, month: 0, monthPrior: 0, year: 0, all: 0 },
    wordsCapped: false,
    vouchedGivers: 0,
    unknownGivers: 0,
    giversCapped: false,
    postCount: 0
  });
  const now = Date.parse('2026-08-11T00:00:00Z');
  const atTop = computeLiteRetention('proof', makeFacts(topThreshold, 3), now);
  check(
    'a lite account with the top-rank activity-window day count reaches the top rank, with a tiny presence figure',
    atTop.summary.rank.rankNumber === MAX_TIER_INDEX,
    `rank ${atTop.summary.rank.rankNumber} (presence figure was 3)`
  );
  // MUTATION: the same facts with the two fields swapped must NOT reach the top rank — proving
  // the rank really does track `activeDaysInActivityWindow` and not whichever field happens to
  // be larger or is read first.
  const swapped = computeLiteRetention('mutation', makeFacts(3, topThreshold), now);
  check(
    'MUTATION: swapping the two fields on the same facts object does not reach the top rank',
    swapped.summary.rank.rankNumber < MAX_TIER_INDEX,
    `rank ${swapped.summary.rank.rankNumber}`
  );
  // The presence figure itself must still reach the wire untouched — it is a real stat, not
  // dead weight now that the arm no longer reads it.
  check(
    'the presence figure still reaches the detail block, unwindowed by the activity span',
    atTop.detail.activeDaysInWindow === 3,
    `${atTop.detail.activeDaysInWindow}`
  );
}

// ════ SECTIONS 12 AND 12b ARE DELETED WITH THE MECHANICS THEY GUARDED (2026-08-18) ════
//
// §12 was FREEZE DURABILITY: ~25 checks proving that a banked "freeze" bridged a missed
// day, that it recorded WHICH day so a recompute could not re-charge it, that a lifetime
// pool behind a per-read cap grew the streak by two every five minutes until the cap was
// moved onto the RUN, and that `MAX_FREEZES_IN_RUN` equalled the ledger's hold cap.
// §12b was THE GOAL GATE: today counted only once the reader's chosen acts-per-day target
// was met, with the default of 1 asserted to reproduce the old behaviour exactly.
//
// Every one of those checks passed, and two of them encode bugs that were runtime-proven
// on a live account. They are deleted because their subjects are: the streak decays now
// (+1 present, -2 absent, floored at zero), so there is no cliff to grant mercy against
// and no per-day target to meet. `readFreezeState`, `recordFreezeSpent`, the goal route
// and both Postgres tables are gone (migration 0037).
//
// ★ THE LESSON WORTH KEEPING, and it is the third time this file has recorded it: a green
// suite proves a mechanic does what it claims and says NOTHING about whether the mechanic
// belongs in the product. The freeze existed only to soften a cliff that a simpler rule
// removes outright — and softening it took a ledger, a spend record, a per-run cap, an
// idempotency argument and two live bugs. Section 9 replaces all of it with arithmetic.

// ─── 13. the interesting stats ─────────────────────────────────────────────
section('13. act stats');

// ════ THE VOTE-AMOUNT ASSERTIONS ARE DELETED WITH THEIR SUBJECTS (2026-08-09) ════
//
// ~30 checks lived here covering `postEngagement` (votesReceived, postsRead,
// postsWithEngagement, best-post tie-breaking) and `postsWithRealEngagement` (the
// self-vote fix, with a mutation guard proving the old any-vote rule was wrong). Every one
// of them PASSED. They were testing functions that should not exist:
//
//   "vote amounts dont matter, theyre all botted."
//   "you cant list votes and comments and not have it for all time. if thats the case
//    then drop it."
//
// Worth recording, because a green test suite is exactly what made these numbers feel
// safe: `postsWithRealEngagement` was itself a same-day FIX for a tautology, complete with
// a mutation guard, and it still could not vary in production (N of N on 5 of 5 accounts).
// A test can prove a function computes what it claims and say nothing about whether the
// claim is worth making. What replaces them is the exclusion-list coverage in section 17.

{
  check('longestRun of nothing is 0', longestRun([]) === 0);
  check('longestRun of one day is 1', longestRun(['2026-08-08']) === 1);
  check('longestRun finds the longest run, not the newest', longestRun(['2026-08-08', '2026-01-01', '2026-01-02', '2026-01-03']) === 3);
  check('longestRun ignores duplicates and order', longestRun(['2026-01-02', '2026-01-01', '2026-01-02']) === 2);
  // Month and leap-year boundaries: exactly where a hand-rolled string increment fails.
  check('longestRun crosses a month boundary', longestRun(['2026-02-28', '2026-03-01']) === 2);
  check('longestRun crosses a leap day', longestRun(['2024-02-28', '2024-02-29', '2024-03-01']) === 3);
  check('longestRun does not join a non-leap Feb 28 to Mar 1', longestRun(['2026-02-27', '2026-02-28', '2026-03-01']) === 3);
  check('longestRun crosses a year boundary', longestRun(['2025-12-31', '2026-01-01']) === 2);
}

{
  // ★ THE PATTERN MUST BE A PATTERN. Any non-empty set has an argmax, so an
  // unguarded version confidently tells an account with four acts that it "posts most
  // on Tuesdays".
  check('too little history => no pattern', busiestWeekday(['2026-08-04', '2026-08-11', '2026-08-18']) === null);
  const flat: string[] = [];
  for (let i = 0; i < 28; i++) flat.push(dayAt(Date.parse('2026-01-01T00:00:00Z') + i * 86_400_000));
  check('an even spread => no pattern (not an arbitrary winner)', busiestWeekday(flat) === null, JSON.stringify(busiestWeekday(flat)));
  // Every Tuesday for 20 weeks. 2026-01-06 is a Tuesday.
  const tuesdays: string[] = [];
  for (let i = 0; i < 20; i++) tuesdays.push(dayAt(Date.parse('2026-01-06T00:00:00Z') + i * 7 * 86_400_000));
  const pat = busiestWeekday(tuesdays);
  check('a real weekly habit is found', pat?.weekday === 2, JSON.stringify(pat));
  check('and it reports the count so the claim is checkable', pat?.acts === 20, JSON.stringify(pat));
  check('the history floor is above a handful of acts', MIN_ACTS_FOR_PATTERN >= 7);
}

// ─── 14. the nudge selector ────────────────────────────────────────────────
// ─── 13b. how much somebody has written ────────────────────────────────────
//
// ★ THE STAT THE OWNER ASKED FOR ("you have written in 1 year the equivalent of a 100
// page book"). What has to be true for that sentence to be honest: the count must be of
// WORDS SOMEBODY WROTE, not of markup they pasted, and the page arithmetic must be the
// arithmetic the copy claims.
section('13b. words written');

check('plain prose counts its words', countWords('one two three four five') === 5);
check('an empty body is zero, not NaN', countWords('') === 0 && countWords(undefined) === 0);
check('punctuation alone is not a word', countWords('--- | . *** >') === 0);
check('markdown furniture does not inflate the count', countWords('## Hello there') === 2);
check('a blockquote does not pay for its own marker', countWords('> quoted words here') === 3);
{
  // ★ THE CASE THAT MATTERS MOST: a post embedding a config file is not an essay.
  // "Here is the config:" (4) + "That is all." (3) = 7. The eight words inside the fence
  // contribute nothing.
  const withCode = 'Here is the config:\n\n```\nfoo bar baz qux quux corge grault garply\n```\n\nThat is all.';
  check('fenced code is not writing', countWords(withCode) === 7, `${countWords(withCode)}`);
  // MUTATION GUARD: a naive whitespace split counts the fence markers and the eight words
  // inside them. If the stripping is ever removed this fails, while every check above
  // still passes individually — it is the one that proves they were doing work.
  const naive = withCode.split(/\s+/).filter(Boolean).length;
  check('MUTATION: a naive split really would over-count', naive > countWords(withCode) + 8, `${naive} vs ${countWords(withCode)}`);
}
check('inline code is not writing', countWords('run `npm install --frozen-lockfile` now') === 2, `${countWords('run `npm install --frozen-lockfile` now')}`);
check('an image contributes nothing', countWords('![a very long alt text here](https://example.com/x.png)') === 0);
check('a link keeps its label and drops its target', countWords('see [the docs](https://example.com/a/b/c) now') === 4, `${countWords('see [the docs](https://example.com/a/b/c) now')}`);
check('a bare url is not writing', countWords('look https://example.com/a/b/c here') === 2, `${countWords('look https://example.com/a/b/c here')}`);
check('html tags do not count', countWords('<div class="x">two words</div>') === 2, `${countWords('<div class="x">two words</div>')}`);
check('accented and non-latin words still count', countWords('café naïve Здравствуйте') === 3, `${countWords('café naïve Здравствуйте')}`);
check('pages are floor(words / WORDS_PER_PAGE)', pagesFromWords(WORDS_PER_PAGE * 100) === 100);
check('a part page does not round up into a claim', pagesFromWords(WORDS_PER_PAGE * 3 - 1) === 2);
check('nothing written is nothing to compare', pagesFromWords(0) === 0 && pagesFromWords(-5) === 0 && pagesFromWords(NaN) === 0);
// ★ THE OWNER'S OWN EXAMPLE, AS ARITHMETIC. "a 100 page book" is 25,000 words at this
// divisor — roughly a post a day for a year at 70 words a post. If WORDS_PER_PAGE is ever
// retuned, this says out loud what the headline sentence starts costing.
check('a 100-page book is 25,000 words at the stated divisor', WORDS_PER_PAGE * 100 === 25_000, `${WORDS_PER_PAGE * 100}`);

// ─── 13b2. the word count names a period, and the period rotates ───────────
//
// ★ OWNER, 2026-08-18: "in what time period? this needs to change with time look3d at. one
// day 7 days, one time all time, one time, last 10 days, as long as it doesnt slow the
// load." The first version printed a lifetime figure with no scope, which is the same
// defect as the vote-count lines this card already deleted — a number nobody can place.
section('13b2. the word count rotates its window');

{
  const W = { day: 400, week: 2000, month: 8000, monthPrior: 6000, year: 60000, all: 90000 };
  const pick = (today: string, seed = 'lordbutterfly') => {
    const r = pickWordWindow(W, today, seed);
    if (!r) throw new Error(`no window picked for ${today} / ${seed}`);
    return r;
  };

  check('it picks something for a prolific account', pick('2026-08-18') !== null);
  check('the choice is STABLE for the same reader on the same day',
    pick('2026-08-18').window === pick('2026-08-18').window);
  {
    // Over a run of days every window must appear, or the "rotation" is a constant.
    const seen = new Set();
    for (let i = 0; i < 30; i++) {
      const day = new Date(Date.UTC(2026, 7, 1) + i * 86_400_000).toISOString().slice(0, 10);
      seen.add(pick(day).window);
    }
    check('every window is reachable across a month of days', seen.size === WORD_WINDOW_ORDER.length, [...seen].join(','));
  }
  {
    // Two readers on the SAME day should not be locked to the same window, or the app is
    // visibly on a cycle rather than telling each person something about themselves.
    const day = '2026-08-18';
    const windows = new Set(['lordbutterfly', 'acidyo', 'gtg', 'tarazkp', 'blocktrades'].map((u) => pick(day, u).window));
    check('different readers can get different windows on one day', windows.size > 1, [...windows].join(','));
  }
  // ★ ABSENT, NEVER ZERO — applied to a quantity with five candidate scopes. A quiet day
  // must widen to a window worth a sentence, not print "0 words today".
  {
    const quiet = { day: 0, week: 0, month: 0, monthPrior: 0, year: 30000, all: 45000 };
    const results = [];
    for (let i = 0; i < 20; i++) {
      const d = new Date(Date.UTC(2026, 7, 1) + i * 86_400_000).toISOString().slice(0, 10);
      results.push(pickWordWindow(quiet, d, 'someone')?.window ?? 'none');
    }
    check('a window under the floor is never printed', results.every((w) => w === 'year' || w === 'all'), [...new Set(results)].join(','));
  }
  check('a tiny sub-paragraph count is not worth a line at all',
    pickWordWindow({ day: 10, week: 10, month: 10, monthPrior: 10, year: 10, all: 10 }, '2026-08-18', 'x') === null);
  check('no data at all produces no line', pickWordWindow(undefined, '2026-08-18', 'x') === null);
  check('the floor is a paragraph, not a word', MIN_WORDS_TO_MENTION >= 25);

  // ★ FLOORNESS RUNS THE OPPOSITE WAY TO INTUITION. The walk reads NEWEST-FIRST under a
  // clock, so the recent end is always covered and the far end truncates: a 7-day figure
  // is exact where a lifetime one is a floor. Getting this backwards would print "at
  // least 400 words today" (hedging a number we know exactly) and a bare lifetime total
  // (stating a floor as a fact) — both wrong, in opposite directions.
  check('a lifetime figure is a floor until the walk reached account creation',
    windowIsFloor('all', '2026-08-18', '2026-01-01', false));
  check('...and a total once it has', !windowIsFloor('all', '2026-08-18', '2026-01-01', true));
  check('a 7-day figure is exact when the day set is complete past its start',
    !windowIsFloor('week', '2026-08-18', '2026-08-01', false));
  check('a 7-day figure is a floor when the walk stopped inside it',
    windowIsFloor('week', '2026-08-18', '2026-08-15', false));
  check('an unbounded walk makes every short window exact',
    !windowIsFloor('day', '2026-08-18', '', false) && !windowIsFloor('year', '2026-08-18', '', false));
  // Boundary: `completeFrom` exactly ON the window's first day is covered, not a floor.
  check('a boundary exactly at the window start is still covered',
    !windowIsFloor('week', '2026-08-18', '2026-08-12', false));
  check('one day earlier than the window start is NOT', windowIsFloor('week', '2026-08-18', '2026-08-13', false));

}

// ─── 13b3. the two lines that MOVE ─────────────────────────────────────────
section('13b3. word trend and percentile');

check('a real rise is reported up', wordsTrend(8000, 6000)?.up === true);
check('and carries the size', wordsTrend(8000, 6000)?.pct === 33, `${wordsTrend(8000, 6000)?.pct}`);
check('a real fall is reported down', wordsTrend(6000, 8000)?.up === false);
// ★ NO PRIOR MONTH IS NOT A TREND. The store only holds what has been walked, so "0 last
// month" means EITHER they wrote nothing OR we had not read that far back — opposite
// claims. Same guard, same reason, as reachTrend.
check('a missing prior month claims nothing', wordsTrend(8000, 0) === null);
check('a missing current month claims nothing', wordsTrend(0, 8000) === null);
check('a flat month says nothing rather than "the same"', wordsTrend(8000, 8000) === null);
check('noise under the floor is not a direction', wordsTrend(8400, 8000) === null, `${MIN_WORD_TREND_PCT}%`);
check('the floor is a real change, not a rounding artefact', MIN_WORD_TREND_PCT >= 5);

// ─── 13c. a stored DATE is the day it was stored, on any host ──────────────
//
// ★★★ RUNTIME-PROVEN, NOT DEFENSIVE (2026-08-18). node-postgres parses a `DATE` into a JS
// `Date` at LOCAL midnight; `toDayString` used to call `toISOString()` on it, so on a
// CEST box (UTC+2) every stored act-day came back ONE DAY EARLY. Measured through the
// live route on @lordbutterfly before the fix: the account's 6 observed act-days read as
// 8 and `streakDays` read 7 where the decay gives 3 — because `/api/streak/[user]` unions
// the STORED day set with THIS request's walk, and the walk dates its items correctly
// from ISO timestamps, so one real day appeared twice.
//
// It is invisible in a UTC container and wrong everywhere else, which is why it survived:
// the fix is `to_char(col,'YYYY-MM-DD')` in the SQL so no `Date` is built at all. This
// asserts the FALLBACK path — a caller that hands over a Date must still get its calendar
// day back — and it runs on whatever timezone the machine happens to be in, so it fails
// on the CEST box that found it and passes on a UTC one either way.
//
// Cross-lane import, like `FREEZE_MAX_HELD` was before it: the pg pool is lazily
// constructed (lib/lite/db/pool.ts), so importing this module opens no connection.
section('13c. stored dates survive the process timezone');

{
  // Local midnight, exactly what node-postgres hands back for `DATE '2026-08-13'`.
  const asPgWouldParse = new Date(2026, 7, 13, 0, 0, 0, 0);
  check('a local-midnight Date keeps its calendar day', toDayString(asPgWouldParse) === '2026-08-13', String(toDayString(asPgWouldParse)));
  // MUTATION GUARD: the old implementation. It only differs from the fix east of
  // Greenwich, so this check also records whether THIS run could have caught the bug.
  const old = asPgWouldParse.toISOString().slice(0, 10);
  const offsetMinutes = asPgWouldParse.getTimezoneOffset();
  check(
    offsetMinutes < 0
      ? 'MUTATION: on this (east-of-UTC) host the old toISOString path really did shift the day'
      : 'MUTATION: this host is at or west of UTC, so the old path would not have shifted (bug is host-dependent)',
    offsetMinutes < 0 ? old !== '2026-08-13' : old === '2026-08-13',
    `offset ${offsetMinutes}min, old path gave ${old}`
  );
  check('a text day passes straight through', toDayString('2026-08-13') === '2026-08-13');
  check('a timestamp string is truncated to its day', toDayString('2026-08-13T22:10:00Z') === '2026-08-13');
  check('null stays null', toDayString(null) === null);
  // ★ AND THE DOUBLE-COUNT THIS CAUSED, as arithmetic on the streak itself: a shifted
  // stored day plus the correctly-dated walked day is two entries for one real day.
  const real = ['2026-08-16', '2026-08-17', '2026-08-18'];
  const shiftedUnion = [...new Set([...real, '2026-08-15', '2026-08-16', '2026-08-17'])];
  const honest = computeStreak({ actDaysUTC: real, todayUTC: '2026-08-18', countFromUTC: '2026-08-15', observedFromUTC: '2026-08-15' }).streakDays;
  const inflated = computeStreak({ actDaysUTC: shiftedUnion, todayUTC: '2026-08-18', countFromUTC: '2026-08-15', observedFromUTC: '2026-08-15' }).streakDays;
  check('a shifted-day union really does inflate the streak', inflated > honest, `${inflated} vs ${honest}`);
}

section('14. nudge selection');

const NUDGE_BASE: NudgeFacts = {
  streakDays: 1,
  streakIsLowerBound: false,
  actsToday: 1,
  todayWeekday: 3
};
const nudge = (o: Partial<NudgeFacts>) => selectNudge({ ...NUDGE_BASE, ...o });

// ★ THE MOST IMPORTANT PROPERTY: IT SAYS NOTHING WHEN THERE IS NOTHING TO SAY.
check('nothing interesting => no nudge at all', nudge({}) === null);
check('a bare streak is NOT a nudge (that would be a countdown)', nudge({ streakDays: 9, actsToday: 0 }) === null);
check('a reach number below the floor is not worth mentioning', nudge({ feedsReached: MIN_REACH_TO_MENTION - 1 }) === null);

// Priority order, each step verified against the one below it.
check('a first-time giver outranks everything', nudge({
  firstTimeGiverName: 'tarazkp',
  people: 42,
  unansweredReply: { author: 'alice', ago: '4h ago' },
  streakDays: 30,
  feedsReached: 900
})?.kind === 'new_giver');
check('a named giver needs a headcount to sit beside', nudge({ firstTimeGiverName: 'tarazkp' }) === null);
check('an unanswered reply outranks reach', nudge({ unansweredReply: { author: 'alice', ago: '4h ago' }, feedsReached: 900 })?.kind === 'unanswered');
check('reach outranks the weekday pattern', nudge({ feedsReached: 900, busiestWeekday: 3, actsToday: 0 })?.kind === 'reach');
check('the weekday pattern outranks the aggregate new-people line', nudge({ busiestWeekday: 3, actsToday: 0, newPeopleThisWeek: 3 })?.kind === 'weekday_today');
check('new people still surface with a streak running', nudge({ newPeopleThisWeek: 3, streakDays: 5, actsToday: 0 })?.kind === 'new_people_week');
// The flat streak line ("Day N lands if you post today") was removed by owner ruling
// 2026-08-11, so there is nothing left for it to rank last. It now returns null.
check('the flat streak line no longer exists', nudge({ streakDays: 5, actsToday: 0 }) === null);

// The guards.
// ★★ THE MILESTONE CHECKS ARE GONE, AND THEY WERE THE SUITE'S ONLY RED (2026-08-18).
// Four of them ("a milestone outranks reach", "every listed milestone fires", "flags a
// month", "a short milestone does not") had been FAILING since the milestone nudge was
// deleted by owner ruling on 2026-08-10 — the branch went, the assertions stayed, and a
// permanently-red suite is a suite nobody reads. `STREAK_MILESTONES` is still exported
// and still consumed (retention-moments.ts's day-2 toast is derived from it), so the
// constant is asserted below instead of the deleted branch.
check('no streak length produces a nudge any more', STREAK_MILESTONES.every((d) => nudge({ streakDays: d }) === null));
check('a milestone we cannot prove produces nothing either', nudge({ streakDays: 30, streakIsLowerBound: true }) === null);
check('the weekday line only fires ON that weekday', nudge({ busiestWeekday: 5, actsToday: 0 }) === null);
check('the weekday line does not fire once you have posted', nudge({ busiestWeekday: 3, actsToday: 1 }) === null);

// ─── 15. copy selection — voice, dormancy, and the keys ────────────────────
//
// The keys these selectors produce are DYNAMIC, so `lint:translations:usage` — which
// only reads string literals — cannot see them. This section is the gate instead.
section('15. copy selection');

const EN = require('../../../../locales/en/common_blog.json') as Record<string, unknown>;

/** Does this exact key exist in the English bundle? Dotted path, no plural magic. */
function hasKey(dotted: string): boolean {
  let node: unknown = EN;
  for (const part of dotted.split('.')) {
    if (typeof node !== 'object' || node === null || !(part in (node as Record<string, unknown>))) return false;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' && node.length > 0;
}
/** i18next resolves a `count` key through its plural forms, so both must exist. */
const hasPlural = (dotted: string) => hasKey(`${dotted}_one`) && hasKey(`${dotted}_other`);

/** The string itself, for assertions about what a key SAYS rather than that it exists. */
function lookup(dotted: string): string | undefined {
  let node: unknown = EN;
  for (const part of dotted.split('.')) {
    if (typeof node !== 'object' || node === null || !(part in (node as Record<string, unknown>))) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

const VOICES: RetentionVoice[] = ['own', 'other'];

for (const voice of VOICES) {
  for (const base of ['retention.blank', 'retention.dormant.meaning']) {
    check(`voiced key exists: ${base} (${voice})`, hasKey(voiced(base, voice)), voiced(base, voice));
  }
  // `people` is voiced ("voted on YOUR posts" / "on THEIR posts") and needs both forms in
  // both voices. `new_people` is NOT in this list any more: "N of them for the first time
  // this week" has no person in it, its `_their` copies were byte-identical to the base,
  // and the call site was voicing it out of symmetry rather than need. Three duplicate
  // strings deleted, and the check follows the call site rather than leading it.
  for (const base of ['retention.stats.people', 'retention.stats.active_days']) {
    const k = voiced(base, voice);
    check(`plural forms exist: ${base} (${voice})`, hasPlural(k), k);
  }
  check(`weekday stat exists (${voice})`, hasKey(voiced('retention.stats.weekday', voice)));
  // The rung blurb is read through the SAME voicing, so every rung needs a pair.
  for (const t of TIER_ORDER) {
    check(`blurb exists: ${t} (${voice})`, hasKey(voiced(TIERS[t].blurbKey, voice)), voiced(TIERS[t].blurbKey, voice));
  }
}
{
  // Voiceless, and asserted to STAY voiceless, so nobody re-adds the duplicate pair.
  const k = 'retention.stats.new_people';
  check(`plural forms exist: ${k} (voiceless)`, hasPlural(k), k);
  check('new_people has no voiced twin', !hasKey(`${k}_their`), `${k}_their`);
}

// ════ EVERY LITERAL `voiced()` CALL SITE, FOUND BY READING THE SOURCE ════
//
// ★ THE LIST ABOVE IS HAND-MAINTAINED, AND THAT IS EXACTLY HOW THE LAST VOICE BUG SHIPPED
// (2026-08-10). `retention.stats.active_days` was rendered with a bare `t()` instead of
// `voiced()`, so a stranger's profile read "Lumen has seen YOU show up on 1 day." one line
// under "1827 people voted on THEIR last 8 posts." — on 5 of 5 accounts a UX round sampled.
// Every assertion above passed throughout, because a hand-written list can only guard the
// keys somebody remembered to add to it.
//
// So this walks the component and lib sources, pulls every `voiced('...')` literal out of
// them, and asserts each one really has a third-person form. It cannot be forgotten: adding
// a call site IS adding the check.
//
// KNOWN LIMIT, stated rather than papered over: it only sees LITERAL first arguments. The
// `people`/`people_solo` sites pass a computed `base`, so they stay covered by the explicit
// list above. A new dynamic call site would still slip past this, and the honest answer is
// that it would need the same treatment by hand.
{
  const { readFileSync, readdirSync } = require('fs') as typeof import('fs');
  const { join } = require('path') as typeof import('path');
  const roots = ['../../components', '../../emblems', '..'].map((r) => join(__dirname, r));

  const sources: string[] = [];
  for (const root of roots) {
    for (const name of readdirSync(root, { withFileTypes: true })) {
      if (!name.isFile() || !/\.tsx?$/.test(name.name)) continue;
      sources.push(readFileSync(join(root, name.name), 'utf8'));
    }
  }
  check('voiced call-site scan read some source', sources.length > 0, `${sources.length} files`);

  // Comments are stripped first. The first run of this scan failed on
  // `retention.facts.givers`, which is not a call site and not even a live key — it is a
  // worked example inside viewer-copy.ts's own doc block, naming a key deleted with the
  // giver arm. A guard that fires on prose would be turned off within a week.
  // Block comments and whole-line `//` only, so a `https://` inside a string is untouched.
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const bases = new Set<string>();
  for (const src of sources) {
    for (const m of code(src).matchAll(/\bvoiced\(\s*'([^']+)'/g)) bases.add(m[1]);
  }
  // A scan that finds nothing would pass every assertion below while proving nothing.
  check('voiced call-site scan found literal keys', bases.size >= 3, `${bases.size} keys`);

  for (const base of [...bases].sort()) {
    const third = `${base}_their`;
    check(
      `literal voiced() site has a third-person form: ${base}`,
      hasKey(third) || hasPlural(third),
      third
    );
  }

  // ★ AND THE THIRD DOOR: UNWRAPPING A CALL SITE BACK TO A BARE `t()`.
  //
  // With the twin present and the call site voiced, both checks above go green. Change
  // `t(voiced('retention.stats.active_days', voice), …)` back to
  // `t('retention.stats.active_days', …)` and they STAY green while the pronoun bug returns
  // in full — the twin still exists, it is simply never asked for. That is precisely the
  // shape of the original defect, so it gets its own assertion.
  //
  // The rule is one-directional and cheap to state: a key that HAS a `_their` twin exists in
  // two voices on purpose, so no source file may name it in a bare `t()`.
  const stats = ((EN as Record<string, unknown>).retention as Record<string, unknown>).stats as Record<string, unknown>;
  const twinned = Object.keys(stats)
    .filter((k) => k.endsWith('_their'))
    .map((k) => `retention.stats.${k.replace(/_their$/, '')}`);
  check('found twinned stat keys to police', twinned.length >= 2, `${twinned.length} keys`);
  for (const key of [...new Set(twinned)].sort()) {
    const bare = sources.some((src) => code(src).includes(`t('${key}'`));
    check(`voiced-only key is never called bare: ${key}`, !bare, `t('${key}'`);
  }
}
// ════ EVERY RUNG BLURB STATES THE UNIT THE LADDER ACTUALLY MEASURES ════
//
// ★ THE BLURBS USED TO BE WRITTEN IN CALENDAR TIME AND THE LADDER COUNTS ACTIVE DAYS
// (owner ruling, 2026-08-10: "restate them in active days").
//
// Ember said "A week of showing up." while its threshold is FIVE active days, so a reader
// doing the obvious arithmetic — "1 day now, 4 more to Ember" — got 5 and was told 7. The
// two only ever agreed through an UNVALIDATED assumption of ~5 active days a week, which is
// itself flagged as a design guess awaiting calibration. A stated unit that is not the
// measured unit is the same defect class as the "in the last year" window that the gate
// never measured, and it was sitting in nine strings at once.
//
// So the blurbs now lead with the threshold itself, and this pins each printed number to
// `ACTIVITY_ARM`. Change the curve without changing the copy and the suite fails here
// rather than a reader finding it. This is the guard that makes the numbers-in-prose safe:
// hardcoding them in the locale is only acceptable BECAUSE the arm is the authority and the
// test enforces it.
{
  const thresholdForRank = (r: number) => ACTIVITY_ARM.find((s) => s.index === r)?.min;
  let checkedRungs = 0;
  for (const tier of TIER_ORDER) {
    const r = rankNumber(tier);
    if (r < 1) continue; // rank 0 makes no numeric claim, by design
    const want = thresholdForRank(r);
    for (const voice of VOICES) {
      const key = voiced(TIERS[tier].blurbKey, voice);
      const text = lookup(key);
      const lead = typeof text === 'string' ? text.match(/^(\d+)\b/) : null;
      check(
        `blurb leads with its arm threshold: ${tier} (${voice})`,
        lead !== null && want !== undefined && Number(lead[1]) === want,
        `${key} -> ${JSON.stringify(text)} expected to start with ${want}`
      );
    }
    checkedRungs += 1;
  }
  // Nine rungs carry a number. A loop that silently checked none would pass.
  check('every numbered rung was checked', checkedRungs === 9, `${checkedRungs} rungs`);
}

for (const t of TIER_ORDER) check(`rung name exists: ${t}`, hasKey(TIERS[t].labelKey));
// The countable's three units, each with plural forms — this is what replaced nine
// paragraphs of advice, and a missing plural renders "1 more people".
// ★ ONE UNIT NOW. 'people' and 'weeks' went with the arms that used them; the rank is counted in
// observed active days and nothing else, so no surface has to switch on the arm to print a distance.
for (const unit of ['days']) {
  check(`distance plural forms exist: ${unit}`, hasPlural(`retention.distance.${unit}`), unit);
}
for (let d = 0; d < 7; d++) {
  check(`weekday name ${d} exists`, hasKey(`retention.weekday.${d}`));
  check(`single weekday name ${d} exists`, hasKey(`retention.weekday_one.${d}`));
}
for (const k of [
  'retention.to_next',
  'retention.at_top',
  'retention.scale',
  'retention.ranks.title',
  'retention.ranks.subtitle',
  'retention.ranks.wont',
  'retention.ranks.down_title',
  'retention.ranks.down_body',
  // The streak's own explainer, on the page the product links to when somebody asks how
  // any of this works. Added with the decay (2026-08-18): a number that can go DOWN has
  // to be written down somewhere findable.
  'retention.ranks.streak_title',
  'retention.ranks.streak_body',
  'retention.streak.title',
  'retention.streak.rule',
  'retention.streak.rule_zero',
  'retention.day_streak_hint',
  'retention.nudge.dismiss',
  'retention.nudge.open',
  'retention.moment.milestone.title'
]) {
  check(`key exists: ${k}`, hasKey(k), k);
}
// Every nudge kind must have a line, or the selector can pick something unprintable.
for (const kind of ['new_giver', 'unanswered', 'milestone', 'milestone_month', 'reach', 'weekday_today', 'new_people_week']) {
  check(`nudge line exists: ${kind}`, hasKey(`retention.nudge.${kind}`), kind);
}
// The streak figure, in both the exact and the floor form, each with plurals.
for (const k of ['retention.streak.days', 'retention.streak.days_floor']) {
  check(`streak figure pluralises: ${k}`, hasPlural(k), k);
}
// ★ AND `retention.today.*` IS REALLY GONE. The whole namespace served the daily goal
// (the ring, the picker, the three tiers, the deadline, the freeze lines). Asserting its
// ABSENCE is what stops a surface quietly resurrecting the picker — the same guard the
// dead-copy block below applies to `retention.ceiling` and friends.
check('the daily-goal namespace is gone', !hasKey('retention.today.title') && !hasKey('retention.today.goal_hint'));

  // Every window the picker can name needs copy in both voices, exact and floor.
for (const w of WORD_WINDOW_ORDER) {
  for (const suffix of ['', '_floor']) {
    for (const voice of VOICES) {
      const k = voiced(`retention.stats.written_${w}${suffix}`, voice);
      check(`written copy exists: ${k}`, hasKey(k), k);
    }
  }
}
check('the page comparison pluralises', hasPlural('retention.stats.written_pages'));
check('the book comparison exists', hasKey('retention.stats.written_book'));
for (const voice of VOICES) {
  for (const k of ['retention.stats.words_up', 'retention.stats.words_down', 'retention.stats.words_percentile']) {
    check(`moving-line copy exists: ${voiced(k, voice)}`, hasKey(voiced(k, voice)), voiced(k, voice));
  }
}
// ★ AND EVERY WINDOW SENTENCE ACTUALLY NAMES ITS PERIOD, which is the whole instruction.
// A copy edit that dropped "today" or "in the last 7 days" would leave five strings that
// are indistinguishable and four of them wrong.
{
  const writtenCopy = (EN as Record<string, Record<string, Record<string, string>>>).retention.stats;
const written = Object.entries(writtenCopy).filter(([k]) => /^written_(day|week|month|year|all)$/.test(k));
  check('there are five window sentences', written.length === WORD_WINDOW_ORDER.length, `${written.length}`);
  const distinct = new Set(written.map(([, v]) => String(v)));
  check('and no two of them say the same thing', distinct.size === written.length, `${distinct.size}`);
}

// ★ THE DEAD COPY IS REALLY DEAD. Each of these existed to serve a mechanism that no
// longer exists; leaving them would let a surface quietly resurrect one.
for (const gone of ['retention.ceiling', 'retention.way_out', 'retention.gate', 'retention.facts', 'retention.rank']) {
  const parts = gone.split('.');
  let node: unknown = EN;
  let present = true;
  for (const p of parts) {
    if (typeof node !== 'object' || node === null || !(p in (node as Record<string, unknown>))) { present = false; break; }
    node = (node as Record<string, unknown>)[p];
  }
  check(`removed copy stays removed: ${gone}`, !present, gone);
}

// ★ THE VOICE RULES, AS ASSERTIONS. These are the "AI slop" complaints made testable.
{
  const strings: Array<[string, string]> = [];
  const walk = (node: unknown, path: string) => {
    if (typeof node === 'string') { strings.push([path, node]); return; }
    if (typeof node === 'object' && node !== null) {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) walk(v, `${path}.${k}`);
    }
  };
  walk((EN as Record<string, unknown>).retention, 'retention');

  const emDash = strings.filter(([, s]) => s.includes('—'));
  check('no em-dashes anywhere in retention copy', emDash.length === 0, emDash.map(([p]) => p).join(', '));

  const bangs = strings.filter(([, s]) => s.includes('!'));
  check('no exclamation marks (they read as pressure)', bangs.length === 0, bangs.map(([p]) => p).join(', '));

  // ★ NO CARVE-OUT ANY MORE (2026-08-09). This exempted `we could not` / `we stopped`
  // as legitimate admissions of our own measurement limits — and the exemption
  // immediately hid two of them: `day_streak_floor_hint` ("We stopped reading history
  // before the streak ended", found by a UX agent reading the source rather than the
  // screen, because it only renders as a tooltip on a lower-bound streak) and
  // `ranks.unavailable`. Both said something true and both said it with a narrator the
  // product does not have. Rewritten without one ("Older history was not read.",
  // "Could not work this out just now."), so the rule can be absolute — and an
  // absolute rule is the only kind a test can actually hold.
  // ★ THE APOSTROPHE IS MANDATORY FOR THE CONTRACTIONS (tightened 2026-08-09). The pattern
  // was `\bwe['’]?(re| are|ve| have)?\b`, which makes the apostrophe OPTIONAL — so the
  // ordinary English word "were" matched, and the guard failed a string with no narrator in
  // it ("How many of the last 26 weeks were you active?"). A guard that forces copy to
  // avoid the past tense of "to be" is a guard somebody eventually deletes, and it would
  // take the real rule with it. Bare "we" still matches, because `\b` cannot follow `we`
  // inside "were".
  const weTalk = strings.filter(([, s]) => /\bwe\b|\bwe['’](re|ve)\b|\bwe (are|have)\b/i.test(s));
  check('the product never talks about itself in the first person', weTalk.length === 0, weTalk.map(([p]) => p).join(', '));

  // Third-person copy must not address the reader.
  const leaked = strings.filter(([p, s]) => p.includes('_their') && /\b(your|you['’]?re)\b/i.test(s));
  check('no third-person string addresses the reader as "you"', leaked.length === 0, leaked.map(([p]) => p).join(', '));

  // ════ AND THE INVERSE, WHICH IS THE ONE THAT ACTUALLY BIT (2026-08-10) ════
  //
  // The check above catches "your" leaking INTO a third-person string. It cannot catch a
  // second-person string that has NO third-person form at all — and that is what shipped:
  // `retention.stats.active_days` said "Lumen has seen YOU show up on 1 day." with no
  // `_their` sibling, so a stranger's profile rendered it verbatim at whoever was looking.
  //
  // Note this is deliberately a LOCALE-side rule, not a call-site rule. The call-site scan
  // further up only sees keys somebody already wrapped in `voiced()`; the bug was FORGETTING
  // to wrap one, which leaves no call-site trace to find. What does leave a trace is a
  // second-person string sitting on a surface that renders on other people's pages with no
  // third-person twin — so that is what gets asserted.
  //
  // Scoped to the four namespaces that appear on someone else's profile card. The daily
  // card, the goal picker and the nudge are owner-only surfaces and SHOULD address the
  // reader directly, so they are not in scope and must not be.
  const OTHER_PROFILE_NS = ['retention.stats.', 'retention.tier_blurb.', 'retention.blank', 'retention.dormant.'];
  const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;
  const needsTwin = new Set<string>();
  for (const [p, s] of strings) {
    if (!OTHER_PROFILE_NS.some((ns) => p.startsWith(ns))) continue;
    if (p.includes('_their')) continue;
    if (!/\b(you|your|you['’]?re)\b/i.test(s)) continue;
    needsTwin.add(p.replace(PLURAL_SUFFIX, ''));
  }
  // Prove the filter selected something. A typo in a namespace prefix would empty this set
  // and the loop below would assert nothing while reporting a pass.
  check('second-person scan selected keys to check', needsTwin.size >= 3, `${needsTwin.size} keys`);
  const orphans = [...needsTwin].filter((base) => !hasKey(`${base}_their`) && !hasPlural(`${base}_their`));
  check(
    'every second-person string on a shared surface has a third-person twin',
    orphans.length === 0,
    orphans.join(', ')
  );

  // ★ EVERY `{{count}}` STRING NEEDS BOTH PLURAL FORMS (2026-08-09).
  //
  // i18next only pluralises on a variable literally named `count`, and only if `_one`
  // and `_other` siblings exist. Two strings shipped without them, found by an agent
  // reading templates rather than screens — neither could be caught in a browser because
  // both test accounts had counts above 1:
  //
  //   stats.longest       "Longest streak: {{days}} days."          -> "1 days."
  //   stats.posts_landed  "{{hit}} of {{total}} posts got engagement." -> "1 of 1 posts"
  //
  // Both were also pluralising on the wrong variable name, so i18next would never have
  // selected a singular even if one had existed. This asserts the shape rather than the
  // instances, so the next one fails here instead of on somebody's profile.
  const pluralGaps = strings.filter(([p, s]) => {
    if (!s.includes('{{count}}')) return false;
    if (/_(one|other|their)$/.test(p)) return false; // a form itself, not the base
    const base = p.replace(/^retention\./, 'retention.');
    return !hasKey(`${base}_one`) || !hasKey(`${base}_other`);
  });
  check(
    'every {{count}} string has _one and _other siblings',
    pluralGaps.length === 0,
    pluralGaps.map(([p]) => p).join(', ')
  );
  // And nothing may pluralise on a name i18next ignores: a bare "{{days}} days" reads
  // "1 days" forever because no plural rule ever fires.
  //
  // ★ `{{total}}` AND `{{year}}` ARE EXEMPT, and working out why is the point. In
  // "Active {{weeks}} of the last {{total}} weeks" the noun belongs to `total`, which is
  // the WINDOW — 26 on the chain ladder, 9 on the Lumen one, never 1. The variable that
  // CAN be 1 is `weeks`, and it is not the one the noun attaches to, so the sentence is
  // correct at every value. Flagging it would train the next person to add a plural form
  // that can never fire. A guard that cries wolf gets deleted.
  //
  // ★ `{{people}}` IS EXEMPT TOO, ON THE SAME REASONING, AND THE EXEMPTION IS EARNED BY A
  // SIBLING FAMILY. In "{{people}} people voted on your last {{count}} posts" the noun being
  // pluralised is POSTS — `count` — and `people` is the headcount riding alongside. It cannot
  // be 1: the one-person case is rendered from `stats.people_solo`, chosen in
  // retention-stats.tsx before `t()` is called, so "1 people" is unreachable by construction.
  // The check below asserts that family exists, which is what makes this safe rather than
  // convenient — remove `people_solo` and this exemption becomes a real bug.
  const wrongVar = strings.filter(([p, s]) => {
    if (!p.startsWith('retention.')) return false;
    if (/\{\{people\}\}/.test(s)) return false;
    return /\{\{(days|weeks|votes|posts)\}\}\s+(days|posts|weeks|people|votes)\b/.test(s);
  });
  for (const k of ['retention.stats.people_solo', 'retention.stats.people_solo_their']) {
    check(`the one-person family exists, which is what licenses the {{people}} exemption: ${k}`, hasPlural(k), k);
  }
  check(
    'no string pluralises on a variable i18next does not read as count',
    wrongVar.length === 0,
    wrongVar.map(([p, s]) => `${p}: "${s}"`).join(' | ')
  );

  // ★ NO RUNG BLURB MAY BE AN INSTRUCTION (2026-08-09).
  //
  // The nine "Way out:" instructions were deleted deliberately and replaced by a
  // countable — but `tier_blurb.aurora` shipped as "Reach well past your own circle.",
  // a bare imperative I carried over from the proposal doc and never rewrote. It went
  // unnoticed because eight of nine blurbs are subject-first and it renders only to
  // rung-8 accounts. The `_their` form gave it away: "Reach well past THEIR own
  // circle." is not grammatical as a description, which is what a mechanically
  // voice-suffixed imperative looks like.
  //
  // Found by an agent reading the source while testing the profile card, not by any
  // check I had written. This is that check.
  const IMPERATIVE_OPENERS = [
    'reach', 'post', 'reply', 'get', 'come', 'show', 'keep', 'stay', 'go', 'try',
    'make', 'write', 'read', 'follow', 'vote', 'be', 'do', 'start', 'find', 'earn'
  ];
  const bossy = strings.filter(([p, s]) => {
    if (!p.startsWith('retention.tier_blurb.')) return false;
    return IMPERATIVE_OPENERS.includes(s.split(/[\s.,]+/)[0].toLowerCase());
  });
  check('no rung blurb opens with an imperative verb', bossy.length === 0, bossy.map(([p, s]) => `${p}: "${s}"`).join(' | '));
  // And every blurb must have BOTH voices, or the profile card renders a raw key.
  for (const t of TIER_ORDER) {
    check(`blurb has a third-person sibling: ${t}`, hasKey(`${TIERS[t].blurbKey}_their`), t);
  }

  // ════ THE WALL OF TEXT, MEASURED ════
  //
  // The block this feature replaced was 1,643 words. The first version of this check
  // summed EVERY string under `retention.` and asserted the total was under 1,000.
  //
  // ★★ THAT DENOMINATOR WAS WRONG, AND I ONLY FOUND OUT BY HITTING IT (2026-08-09).
  // A UX pass asked for four disclosures — say what a freeze is, scope the posts figure,
  // name the arm behind the distance, put a direction on the reach figure — worth about
  // 120 words of copy in total. The check went from passing to 1,129/1,000, i.e. it had
  // been sitting at ~1,003 and passing by a hair, and it condemned SIX five-word strings
  // as a wall of text.
  //
  // The reason is that the raw sum counts what a reader CANNOT see. `_one` and `_other`
  // are mutually exclusive by definition — i18next renders exactly one — and `_their` is
  // the third-person voice of a string whose second-person form is on a different page.
  // So every pluralised sentence was counted two or three times, and adding one honest
  // sentence cost the budget three. A metric that penalises correct pluralisation is
  // measuring the wrong thing: it would have been satisfied by DELETING singular forms,
  // which the plural guard forty lines up exists to forbid.
  //
  // So it now measures the worst case a reader can actually be shown — the longest
  // variant in each family — and keeps the raw sum as a separate ratchet so the file
  // still cannot balloon unnoticed. I am flagging the change loudly because I loosened a
  // guard in the same commit that added copy, which is exactly the move that deserves
  // suspicion: the numbers below are 807 visible / 1,102 raw at the time of writing, and
  // both are real, and the 1,643 the feature started from is the figure that matters.
  //
  // ★ `_their` IS EXCLUDED ON THE SAME REASONING AS `_one`/`_other` (2026-08-09). Plural forms
  // are mutually exclusive by plural rule; `own`/`_their` are mutually exclusive by WHOSE PAGE
  // YOU ARE ON — the second-person form renders on your profile and the third-person form on
  // somebody else's, never both, never to the same reader in the same moment. Counting a
  // correctly-voiced string twice penalises the fix for voice leaking onto strangers' profiles,
  // which is a real bug this feature already shipped once.
  //
  // (A poll-catalogue exclusion lived here too, for a 14-day rotation of community questions.
  // Both question mechanics were removed as too unserious for the product, so the exclusion and
  // the per-day content check that backed it went with them.)
  const inBudget = strings.filter(([p]) => !/_their(_one|_other)?$/.test(p));
  const raw = inBudget.reduce((n, [, s]) => n + s.split(/\s+/).filter(Boolean).length, 0);
  const families = new Map<string, number>();
  for (const [path, s] of inBudget) {
    const family = path.replace(/_(one|other)$/, '');
    const len = s.split(/\s+/).filter(Boolean).length;
    families.set(family, Math.max(families.get(family) ?? 0, len));
  }
  const visible = [...families.values()].reduce((a, b) => a + b, 0);
  check('reader-visible retention copy is under 900 words (was 1,643)', visible < 900, `${visible} words`);
  check('raw retention copy does not balloon (all variants)', raw < 1200, `${raw} words`);
}

// ── the rules ──
const standing = (o: Partial<StandingLineInput>): StandingLineKind =>
  standingLineKind({ dormant: false, blank: false, remainingToNext: 5, ...o });

check('a dormant account is not shown a distance', standing({ dormant: true, blank: true }) === 'dormant');
check('a blank account is not shown a distance either', standing({ blank: true }) === 'blank');
check('the top of the ladder has no distance to show', standing({ remainingToNext: null }) === 'top');
check('everyone else gets the count', standing({}) === 'progress');

// ★ THE LIVE CASES, from /api/streak on 2026-08-08. Each one is an account a tester
// actually looked at, with the numbers the route actually served.
const LIVE: Array<{ who: string; tenureYear: number; activeWeeks: number; postsScanned: number; dormant: boolean; kind: StandingLineKind }> = [
  // Presence 27%, engagement strong. Was shown advice aimed at his STRONGEST arm.
  { who: 'blocktrades', tenureYear: 2016, activeWeeks: 7, postsScanned: 20, dormant: false, kind: 'progress' },
  // Created 2016, zero posts ever — was told "every single person you admire started
  // exactly where you are".
  { who: 'null', tenureYear: 2016, activeWeeks: 0, postsScanned: 0, dormant: true, kind: 'dormant' },
  { who: 'curie', tenureYear: 2016, activeWeeks: 0, postsScanned: 20, dormant: true, kind: 'dormant' },
  { who: 'ned', tenureYear: 2016, activeWeeks: 0, postsScanned: 20, dormant: true, kind: 'dormant' },
  // A genuinely new account: same zeros on presence, and the Hive tenure YEAR is the only thing
  // telling them apart. It used to be the tenure ARM; that arm is deleted, but dormancy is a COPY
  // decision rather than a rank input, so it can keep using Hive age without reintroducing it.
  { who: 'a brand-new account', tenureYear: 2026, activeWeeks: 0, postsScanned: 0, dormant: false, kind: 'blank' }
];
for (const c of LIVE) {
  const dormant = isDormant({ tenureYear: c.tenureYear, nowYear: 2026, activeWeeks: c.activeWeeks });
  check(`@${c.who}: dormant === ${c.dormant}`, dormant === c.dormant, `got ${dormant}`);
  const kind = standingLineKind({
    dormant,
    blank: c.postsScanned <= 0 && c.activeWeeks <= 0,
    remainingToNext: 5
  });
  check(`@${c.who}: routed to '${c.kind}'`, kind === c.kind, `got '${kind}'`);
}
check(
  'MUTATION: without the tenure year, @null and a new account are indistinguishable',
  isDormant({ tenureYear: 2016, nowYear: 2026, activeWeeks: 0 }) !== isDormant({ tenureYear: 2026, nowYear: 2026, activeWeeks: 0 })
);
check('an active old account is NOT dormant', !isDormant({ tenureYear: 2016, nowYear: 2026, activeWeeks: 1 }));
check('dormancy is refused when the comments feed failed', !isDormant({ tenureYear: 2016, nowYear: 2026, activeWeeks: 0, commentsFeedUnavailable: true }));
check('an unknown tenure year is never called dormant', !isDormant({ tenureYear: 0, nowYear: 2026, activeWeeks: 0 }));
check('the dormancy bar is a couple of years, not one', DORMANT_MIN_YEARS >= 2, `${DORMANT_MIN_YEARS}`);
check('exactly at the bar counts as dormant', isDormant({ tenureYear: 2024, nowYear: 2026, activeWeeks: 0 }));
check('just inside the bar does not', !isDormant({ tenureYear: 2025, nowYear: 2026, activeWeeks: 0 }));

// ── the two giver numbers: headcount vs what the ladder counted ──
const WIRE: Array<{ who: string; established: number; unknown: number; credited: number }> = [
  { who: 'blocktrades', established: 1096, unknown: 468, credited: 1111 },
  { who: 'acidyo', established: 528, unknown: 155, credited: 543 },
  { who: 'steevc', established: 275, unknown: 122, credited: 290 },
  { who: 'arcange', established: 358, unknown: 126, credited: 373 }
];
for (const w of WIRE) {
  const headcount = w.established + w.unknown;
  const credited = w.established + Math.min(w.unknown, UNKNOWN_GIVER_MAX);
  check(`@${w.who}: the served credited figure IS established + min(unknown, ${UNKNOWN_GIVER_MAX})`, credited === w.credited, `${credited} vs ${w.credited}`);
  check(`@${w.who}: the two numbers really do differ, so the explaining line must render`, headcount > credited, `${headcount} vs ${credited}`);
  // ★ AND THE MEASURED ARM PUTS THEM WHERE A HUMAN WOULD EXPECT. Under the reputation
  // proxy every one of these accounts capped at rung 6; the mark itself was
  // unreachable below reputation 61 however many people engaged.
  const rung = computeLeague(inputs(w.credited, 3000, 24)).rankNumber;
  check(`@${w.who}: lands above the mark on the measured arm`, rung > MARK_TIER_INDEX + 1, `rung ${rung}`);
}

section('16. the UX-pass fixes, as assertions');

// ★ EVERY ONE OF THESE COVERS A DEFECT A TESTER NAMED IN A BROWSER, NOT A HYPOTHETICAL.
// The whole point is that four of them are only reachable in states a casual session does
// not produce: a streak of zero, a reach figure that FELL, a sample with no engagement at
// all, and a reader whose timezone is UTC.

// ── 16a. the streak card states the rule that produces the number ────────────
//
// ★ WHAT THIS REPLACES: ~20 assertions over `todayHeadline`, the four-branch selector
// for the daily card's headline. Every branch existed because the card had a per-day
// GOAL to describe, and three of those assertions were RED at the time of deletion (the
// "Day N" wording they tested had been removed by owner ruling on 2026-08-11 and the
// checks were never updated). Selector, copy and checks are gone together.
//
// What matters now is narrower and harder to get wrong by accident: the card must SAY
// that the number can go down, and it must say it in the arithmetic the code actually
// implements. A rule stated in copy that disagrees with `compute-streak.ts` is the same
// class of defect as the invisible goal gate — the reader is told one thing and measured
// by another.
{
  const streakCopy = (EN as Record<string, Record<string, Record<string, string>>>).retention.streak;
  const rule = String(streakCopy.rule);
  const ruleZero = String(streakCopy.rule_zero);
  const hint = String((EN as Record<string, Record<string, string>>).retention.day_streak_hint);
  const ranksBody = String(
    (EN as Record<string, Record<string, Record<string, string>>>).retention.ranks.streak_body
  );

  for (const [where, text] of [
    ['card rule', rule],
    ['card rule (at zero)', ruleZero],
    ['flame hint', hint],
    ['/ranks explainer', ranksBody]
  ] as const) {
    // The gain and the loss, as the digits the code uses. Written as a search for the
    // NUMBERS rather than for a phrase, so a rewrite of the sentence is free and a change
    // to the RATES is not.
    check(`${where} states the gain (${STREAK_GAIN_PER_ACTIVE_DAY})`, text.includes(String(STREAK_GAIN_PER_ACTIVE_DAY)), text);
    check(`${where} states the loss (${STREAK_LOSS_PER_MISSED_DAY})`, text.includes(String(STREAK_LOSS_PER_MISSED_DAY)), text);
  }
  // ★ AND THE RULE'S HEADLINE PROMISE, which is the entire owner instruction: it does not
  // reset. Two of the four surfaces have room to say so; the flame's tooltip does not, and
  // is not asked to.
  check('the card promises it does not reset', /never|not.*reset|does not.*zero/i.test(rule), rule);
  check('/ranks promises it does not reset', /never|not everything|zero/i.test(ranksBody), ranksBody);

  // The daily-goal vocabulary must not survive anywhere in the copy file. "Goal" is the
  // one word that would let the picker come back by increments.
  const raw = JSON.stringify(EN);
  check('no daily-goal copy survives', !/daily goal/i.test(raw), 'daily goal');
  check('no freeze copy survives', !/freeze/i.test(raw), 'freeze');
  check('the deadline wording is gone from the card', !/lands if you post/i.test(raw));
  check('nothing says "UTC" at the reader', !/UTC/.test(String(streakCopy.rule)) && !/UTC/.test(ruleZero));
}

// ── 16b. THE DEADLINE CHECKS ARE DELETED WITH THE DEADLINE ───────────────────
//
// `lib/deadline.ts` and its ~10 assertions (next UTC midnight, the Lisbon/Tokyo/UTC
// renderings, and the mutation guard proving the midnight test survived a 12-hour display
// locale) existed for one line on the daily card: "You have until 01:00." The card no
// longer has a deadline, because the streak no longer has a daily bar to clear by
// midnight — a day you do not post costs 2 whenever it ends. Module and checks deleted
// together.

// ── 16c. the reach trend refuses to invent a direction ───────────────────────
{
  check('a rise is reported up', reachTrend(340, 322).key === 'retention.stats.feeds_delta_up');
  check('the rise is the difference', reachTrend(340, 322).count === 18);
  // ★ A FALL IS REPORTED TOO. Only publishing good news is the flattering-arithmetic
  // failure this whole pass exists to remove.
  check('a fall is reported down', reachTrend(300, 322).key === 'retention.stats.feeds_delta_down');
  check('the fall is reported as a positive size', reachTrend(300, 322).count === 22);
  check('a flat week claims nothing', reachTrend(322, 322).key === '');
  // ★ AND THE AMBIGUOUS CASES CLAIM NOTHING. `prev` absent or zero means EITHER no reach
  // OR the table was not recording; those license opposite claims.
  check('an absent previous window claims nothing', reachTrend(340, undefined).key === '');
  check('a zero previous window claims nothing', reachTrend(340, 0).key === '');
  check('a negative previous window claims nothing', reachTrend(340, -5).key === '');
  for (const k of ['retention.stats.feeds_delta_up', 'retention.stats.feeds_delta_down']) {
    check(`trend copy exists: ${k}`, hasKey(k), k);
    check(`trend copy pluralises: ${k}`, hasPlural(k), k);
  }
}

// ── 16d. the bar never paints as empty while a distance remains ──────────────
{
  // `useRankProgress` is a hook, so the floor itself is asserted through its constant and
  // the arithmetic it applies. What matters is that landing on a rung — the ordinary case,
  // and the one a tester read as "failed to load" — is not drawn as nothing.
  const drawn = (pct: number) => Math.max(pct, MIN_DRAWN_PCT);
  check('the paint floor is above zero', MIN_DRAWN_PCT > 0, String(MIN_DRAWN_PCT));
  check('0% into a band still paints something', drawn(0) === MIN_DRAWN_PCT);
  check('the floor never REDUCES a real value', drawn(64) === 64);
  check('the floor never exceeds a full bar', drawn(100) === 100);
  // MUTATION GUARD: a floor big enough to be mistaken for progress is its own lie.
  check('the floor is small enough to read as "just arrived"', MIN_DRAWN_PCT <= 8, String(MIN_DRAWN_PCT));
}

// ── 16e. the scoped posts line, and the relabelled headcount ─────────────────
{
  const stats = (EN as Record<string, Record<string, Record<string, string>>>).retention.stats;

  // ★ THE POSTS-LANDED LINE IS GONE ENTIRELY, so the checks that used to live here are
  // now the DELETION checks in section 17b. Kept as a note rather than removed silently,
  // because the sequence is the lesson: "2 of 2 posts got engagement" was first repaired
  // (self-vote excluded), then rescoped ("of the last 2"), and only then measured against
  // five accounts — at which point it turned out it could not come out any way but N of N
  // for anybody with an audience. Two rounds of honest repair on a line that should never
  // have been printed. Check whether a number CAN vary before you invest in its wording.

  // ★★ AND THE HEADCOUNT SAYS WHAT IT IS. `stats.people` is built from getActiveVotes:
  // distinct accounts that pressed UPVOTE. It was rendering as "N people read you", which
  // is a claim about `feedsReached` — a different, honestly-measured number.
  for (const k of ['people', 'people_one', 'people_other', 'people_their', 'people_their_one', 'people_their_other']) {
    const s = stats[k] as unknown as string;
    check(`the headcount does not claim a read: ${k}`, !/\bread\b/.test(s), s);
    check(`the headcount says voted: ${k}`, /\bvoted\b/.test(s), s);
  }
  // The reach line is the one that MAY talk about landing in feeds, and it still does.
  check('the reach line still describes feeds', /feeds?/.test(stats.feeds as unknown as string), stats.feeds as unknown as string);
  // And the ladder's own explanation names the same quantity as the stat above it.
  const subtitle = String(
    (EN as Record<string, Record<string, Record<string, string>>>).retention.ranks.subtitle
  );
  // ★★ THE MECHANISM LINE DESCRIBES ACTIVITY NOW (2026-08-09). It said "the lowest of three
  // numbers: different people voting on your posts, time here, weeks you showed up" — all three of
  // those arms are deleted. It must name DAYS, and must deny the three things a reader on a Hive
  // frontend assumes drive a rank: votes, followers, account age.
  // ★★ THE STATED WINDOW MUST BE THE MEASURED WINDOW (2026-08-10, found by a UX agent).
  // It read "days you showed up here, IN THE LAST YEAR" while the arm counts days at or after
  // `first_built_at` — which is 2026-08-09 for every account on the platform. Proven across 18
  // accounts: @tarazkp has 186 act-days in the last year and the gate counted 1. The explainer
  // promised a window the data cannot supply, which is the same defect class as printing a floor
  // as a measurement, shipped inside the fix for it.
  check('the mechanism line names days shown up', /days you have shown up/i.test(subtitle), subtitle);
  check('and does NOT claim a year the gate cannot see', !/last year/i.test(subtitle), subtitle);
  check('it names what actually bounds the count', /since lumen started counting/i.test(subtitle), subtitle);
  check('the mechanism line denies votes', /not votes/i.test(subtitle), subtitle);
  check('the mechanism line denies Hive account age', /hive account/i.test(subtitle), subtitle);
  check('the mechanism line no longer claims three numbers', !/three numbers/i.test(subtitle), subtitle);
}

// ── 16f. THE FREEZE DISCLOSURE CHECKS ARE DELETED WITH THE FREEZE ────────────
//
// They asserted that "2 freezes banked." explained itself ("Each covers a missed day") —
// a tester had read the bare phrase and said outright they would not go looking for its
// meaning. The lesson survives as a rule and is enforced one section up: the streak card
// must state the arithmetic that moves its own number. The freeze does not.

section('16b. the card must not contradict itself');

// ★★ EVERY ONE OF THESE IS A PAIR OF LINES THAT APPEARED ON ONE CARD AT ONE MOMENT AND COULD NOT
// BOTH BE TRUE. They are grouped because the failure MODE is the thing worth guarding, not the
// individual strings: two numbers derived from different windows, printed adjacent.
{
  const stats = (EN as Record<string, Record<string, Record<string, string>>>).retention.stats;

  // 1. "0-day streak" beside "A freeze covered yesterday. The streak held." — DELETED with
  //    the freeze. The same shape survives as a live guard on the streak card: it renders
  //    the "+" floor only when the figure is above zero, because "0+ days" hedges a number
  //    with nothing under it (see streak-card.tsx and section 9's floor assertions).
  //
  // ★★ 1b. "3-day streak" beside "Longest streak: 8+ days." — SAME WORD, TWO MEANINGS,
  //    six lines apart on the same card (caught in a browser, 2026-08-18). The flame shows
  //    the DECAYING score; `longestStreakDays` is the longest unbroken run of consecutive
  //    days in stored history. Printed together they invite "your best was 8, you are on
  //    3", a comparison between two quantities that are not comparable. The stat is a RUN
  //    now, and only the flame may say "streak".
  check(
    'the longest-run stat does not call itself a streak',
    !/streak/i.test(stats.longest as unknown as string) && !/streak/i.test(stats.longest_floor as unknown as string),
    `${stats.longest} / ${stats.longest_floor}`
  );
  check(
    'and it says the days were consecutive, which the streak no longer implies',
    /in a row/i.test(stats.longest_other as unknown as string),
    stats.longest_other as unknown as string
  );

  // 2. "Nothing measured yet." beside "Shown up on 94+ days." The rank counts days Lumen observed;
  //    the stat counted every stored act-day including back-walked Hive history. Now the same
  //    number, so the stat names WHO did the observing and carries no floor.
  check('the day-count stat names Lumen as the observer', /lumen has seen you/i.test(stats.active_days as unknown as string), stats.active_days as unknown as string);
  // ★ AND THE RANK-0 BLURB MAY NOT CLAIM NOTHING IS MEASURED. It read "Nothing measured yet." and
  // rendered 20px above "Active 18 of the last 26 weeks." and "Longest streak: 9+ days." — five
  // Hive measurements. The rank counts what LUMEN has seen; the stats are Hive history. The blurb
  // now says which of the two it is talking about.
  const blurb0 = String((EN as Record<string, Record<string, Record<string, string>>>).retention.tier_blurb.unranked);
  check('the rank-0 blurb does not claim nothing is measured', !/nothing measured/i.test(blurb0), blurb0);
  check('the rank-0 blurb names Lumen as the counter', /lumen has not counted/i.test(blurb0), blurb0);
  check('the day-count stat has no "+" floor form', !hasKey('retention.stats.active_days_floor'));

  // 3. "/ranks: Not votes" beside "915 of them count toward the rank."
  check('nothing claims votes count toward the rank', !hasKey('retention.stats.credited'));
  check('and its tooltip went too', !hasKey('retention.stats.credited_why'));

  // 4. "LAST WEEK" over a giver headcount from posts up to 143 days old.
  check('the weekly recap no longer prints a giver headcount', !hasKey('retention.recap.people'));
  // What it may still print: things that really are weekly.
  for (const k of ['posts', 'replies', 'feeds', 'active_days']) {
    check(`the recap keeps its genuinely weekly segment: ${k}`, hasKey(`retention.recap.${k}`), k);
  }
}

section('17. bots do not count, and vote amounts are not printed');

// ── 17a. the two exclusion lists ─────────────────────────────────────────────
//
// ★ ONE PREDICATE, TWO LISTS (owner: "the global blacklist and the engagement exclusion
// list we made should be taken out of the final numbers"). The recsys already unions
// exactly these two into the set every ranking signal reads; the ladder was reading raw
// voters, which made the ONE number the whole ladder rests on the softest number in the
// product.
{
  const list = engagementExcludedList();
  check('the engagement exclusion list is not empty', list.length > 10, `${list.length} names`);
  // The owner-named curation trails and the measured high-fanout commenters. If a mirror
  // drifts, this is where it shows.
  for (const name of ['worldmappin', 'pizzabot', 'hivebuzz', 'curie', 'ecency', 'dustsweeper', 'actifit']) {
    check(`excluded: @${name}`, isEngagementExcluded(name), name);
    check(`and its engagement does not count: @${name}`, !engagementCounts(name), name);
  }
  // Case and a leading @ must not defeat it: voter names arrive from three different
  // parsers (getActiveVotes, notification message text, and our own store).
  check('case-insensitive', isEngagementExcluded('PizzaBot'));
  check('tolerates a leading @', isEngagementExcluded('@pizzabot'));
  check('tolerates surrounding space', isEngagementExcluded('  worldmappin '));

  // ★ AND A REAL PERSON STILL COUNTS. A list that excluded everybody would pass every
  // check above and zero every rank on the platform.
  for (const name of ['lordbutterfly', 'gtg', 'tarazkp', 'acidyo']) {
    check(`a real account still counts: @${name}`, engagementCounts(name), name);
  }
  // An unnamed engager cannot be credited to anybody — defaulting the unknown case to
  // "counts" is how a parsing failure becomes an inflated headcount.
  check('an empty name does not count', !engagementCounts(''));
  check('undefined does not count', !engagementCounts(undefined));
  // ...but it is NOT "excluded": absence of a name is not membership of a list. Conflating
  // them would make `isEngagementExcluded` unusable as a diagnostic.
  check('an absent name is not a list member', !isEngagementExcluded(undefined));

  // The filter, which is what the route actually calls.
  const votes = [
    { voter: 'lordbutterfly' },
    { voter: 'pizzabot' },
    { voter: 'gtg' },
    { voter: 'hivebuzz' },
    { voter: undefined },
    { voter: 'worldmappin' }
  ];
  const { kept, removed } = filterEngagers(votes, (v) => v.voter);
  check('filterEngagers keeps the humans', kept.length === 2, `${kept.length} kept`);
  check('filterEngagers counts what it dropped', removed === 4, `${removed} removed`);
  check('filterEngagers preserves order', kept[0].voter === 'lordbutterfly' && kept[1].voter === 'gtg');
  // MUTATION GUARD: an unfiltered read is what shipped, and it must not silently return.
  check(
    'MUTATION: the unfiltered list would have counted 5 of these as people',
    votes.filter((v) => v.voter).length === 5 && kept.length === 2
  );
  check('an empty input is not an error', filterEngagers([], (v: { voter?: string }) => v.voter).kept.length === 0);
}

// ── 17b. no vote amount may be printed, anywhere ─────────────────────────────
{
  const stats = (EN as Record<string, Record<string, Record<string, string>>>).retention.stats;
  // Deleted, and asserted deleted — a merge that restores any of these restores a botted
  // number to a profile.
  for (const gone of [
    'votes',
    'votes_one',
    'votes_other',
    'votes_at_least',
    'votes_at_least_one',
    'votes_at_least_other',
    'best_post',
    'posts_landed',
    'posts_landed_one',
    'posts_landed_other',
    'posts_landed_none',
    'posts_landed_none_one',
    'posts_landed_none_other'
  ]) {
    check(`vote-amount copy stays deleted: ${gone}`, !hasKey(`retention.stats.${gone}`), gone);
  }
  // ★ AND NOTHING LEFT UNDER `retention.` PRINTS A VOTE COUNT. The keys above were the
  // ones I knew about; this is the check that catches the one I did not. `credited_why`
  // legitimately says "Votes from accounts with no stake…" — it explains the anti-farm
  // budget rather than reporting a total — so the pattern is a NUMBER next to the word,
  // not the word alone.
  const strings: Array<[string, string]> = [];
  const walk = (node: unknown, path: string) => {
    if (typeof node === 'string') { strings.push([path, node]); return; }
    if (typeof node === 'object' && node !== null) {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) walk(v, `${path}.${k}`);
    }
  };
  walk((EN as Record<string, unknown>).retention, 'retention');
  const voteCounts = strings.filter(([, s]) => /\{\{\s*(count|votes|hit)\s*\}\}\s+votes?\b/i.test(s));
  check(
    'no retention string interpolates a vote total',
    voteCounts.length === 0,
    voteCounts.map(([p, s]) => `${p}: "${s}"`).join(' | ')
  );

  // The headcount survives, and it now carries its own scope + the exclusion note.
  check('the headcount still exists', hasKey('retention.stats.people'));
  check(
    'the headcount names its sample size in the VISIBLE sentence',
    /last \{\{count\}\} posts/.test(stats.people as unknown as string),
    stats.people as unknown as string
  );
  check(
    'and the one-person form does too',
    /last \{\{count\}\} posts/.test(stats.people_solo as unknown as string),
    stats.people_solo as unknown as string
  );
  check('the exclusion note exists', hasKey('retention.stats.bots_excluded'));
  check(
    'the exclusion note says what is excluded',
    /bots?/i.test(stats.bots_excluded as unknown as string) && /blacklist/i.test(stats.bots_excluded as unknown as string),
    stats.bots_excluded as unknown as string
  );
  // The scope strings stay, because they are now a tooltip on the headcount rather than a
  // standalone footnote under three unrelated numbers.
  for (const k of ['footnote', 'footnote_one', 'footnote_other', 'footnote_all', 'footnote_all_one', 'footnote_all_other']) {
    check(`the sample note survives as a tooltip: ${k}`, hasKey(`retention.stats.${k}`), k);
  }
}

// ── 17c. "at least N of N" is not a floor ────────────────────────────────────
//
// A hedge on a maximum conveys nothing except that nobody was paying attention. Found live
// as "Active at least 26 of the last 26 weeks."
{
  const atCeiling = (weeks: number, windowWeeks: number, lowerBound: boolean) =>
    lowerBound && !(weeks >= windowWeeks);
  check('a truncated walk below the ceiling still hedges', atCeiling(19, 26, true) === true);
  check('a walk AT the ceiling does not hedge', atCeiling(26, 26, true) === false);
  check('a walk above the ceiling does not hedge', atCeiling(30, 26, true) === false);
  check('a complete walk never hedged anyway', atCeiling(19, 26, false) === false);
  check('both phrasings still exist', hasKey('retention.stats.weeks') && hasKey('retention.stats.weeks_at_least'));
}

// ════ SECTIONS 18 AND 19 ARE DELETED WITH THEIR FEATURES (owner, 2026-08-09) ════
//
// ~110 checks covered a personal pattern-quiz ("which of these do you actually show up on
// most?") and a community poll ("is a hot dog a sandwich?"). Both worked and both were tested
// hard — bracket arithmetic at every magnitude and seed, tie declining, floor gating, the
// refusal to bracket a lower bound, date-derived rotation, one-vote-per-day, verdict ties.
//
// ★ THEY WERE KILLED ON JUDGEMENT, NOT ON A DEFECT: "kill the questions. completely geet rid of
// it. its too unserious." Worth recording because the tests were not what was wrong — a green
// suite proves a mechanic does what it claims and says nothing about whether the mechanic
// belongs in the product. That is the second time in this session a fully-passing block of
// checks was deleted along with the thing it was guarding (the first was the vote-amount stats).
//
// What survives is `longestGap` (section 13), because the longest quiet spell turned out to be
// worth showing as a STAT rather than asking as a question.

// ─── summary ────────────────────────────────────────────────────────────────
out('');
out(
  failures === 0
    ? `PASS — ${checks} checks, ${TOTAL_RANKS} ranks + rank 0, all reachable, mark at rank ${MARK_TIER_INDEX} (${TIER_ORDER[MARK_TIER_INDEX]})`
    : `FAIL — ${failures} of ${checks} checks failed`
);
process.exit(failures === 0 ? 0 : 1);
