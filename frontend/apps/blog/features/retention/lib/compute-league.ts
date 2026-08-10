import { LeagueArm, LeagueArmUnit, LeagueRank } from '../types';
import { MAX_TIER_INDEX, TIERS, TIER_ORDER, TOTAL_RANKS, nextTier } from './tiers';

/**
 * The keystone-gated ladder computation — the anti-farm heart of the system.
 *
 * The visible rung is the MINIMUM of three independent MEASURED arms:
 *   - received engagement: how many distinct CREDITED people engaged with you,
 *   - account tenure: uncompressible calendar time,
 *   - rolling active-weeks: sustained presence, and the decay/demotion driver.
 * You cannot rise past your weakest arm, so a high-emission bot with no real
 * received engagement and thin tenure is pinned to the bottom forever. Streak
 * length and anything client-side are NOT inputs (anti-farm invariant AF-1).
 *
 * ★ REPUTATION IS GONE FROM THIS FILE (2026-08-09, owner ruling).
 *
 * The engagement arm used to be `f(Hive reputation) * (0.4 + 0.6 * breadth)`. Three
 * things were wrong with that and they compounded:
 *
 *   1. IT WAS NOT THE SPECIFIED QUANTITY. The 2026-07-20 build map defined the arm
 *      as received engagement "weighted by the GIVER's stake × rep". Reputation of
 *      the ACCOUNT ITSELF is a different measurement: it says how old and how
 *      voted-on you are, not who values you now.
 *   2. IT CAPPED THE LADDER. Computed from the shipped constants: the proxy
 *      saturated at 0.79 against a 0.80 band edge, so rungs 7, 8 and 9 could not be
 *      awarded to ANY input, and the codebase carried a whole subsystem
 *      (PROXY_BAND_CEILING, MAX_AWARDABLE_*, UNAWARDABLE_TIERS, isCeilingLimited,
 *      two hooks, seven translation keys) whose only job was to apologise for it.
 *      All of it is deleted, because the reason for it is deleted.
 *   3. IT HAD NO COUNTABLE. Reputation is a lifetime log accumulator, so "how much
 *      more do I need" had no answer, so every surface printed prose instead of a
 *      number — nine static strings of advice. `remainingToNext` is why the arm is
 *      now a headcount: "12 more people" needs no paragraph.
 *
 * A fourth reason, from the 2026-08-08 council: reputation is GRIEFABLE. A third
 * party can push it down with downvotes at no cost, and the old
 * `engagementFromReputation` clamped to 0, which floored the rung regardless of
 * five years of tenure. A stranger could demote you. Distinct credited givers
 * cannot be removed by anybody except the givers.
 *
 * Each arm is a table of (min value → ladder index) steps, so the band boundary
 * and the progress-within-band come from ONE source and cannot drift apart. Every
 * table is now DENSE — one step per ladder index, no skipped indices — which is
 * what makes `remainingToNext` mean "one rung" rather than "somewhere above here".
 *
 * ★★ AND THEN THE HEADCOUNT ARM WENT TOO (2026-08-09, same day, later). Everything above is
 * the history of replacing reputation with credited givers, and it was right about reputation
 * and wrong about what should take its place. The giver count is vote-derived, and votes on Hive
 * are botted — so an established account arrived at rank 8 of 9 on its first request, having done
 * nothing on Lumen. See ACTIVITY_ARM below for what replaced all three arms and why one
 * unpurchasable arm beats three guarded by a MIN.
 *
 * EXPORTS: LeagueInputs, ACTIVITY_ARM, ACTIVITY_WINDOW_DAYS, ACTIVITY_SATURATION_DAYS,
 * MARK_TIER_INDEX, armPosition, activityBandIdx, computeLeague.
 */

export interface LeagueInputs {
  /**
   * Distinct days, inside the trailing ACTIVITY_WINDOW_DAYS, on which this account did
   * something — AND which Lumen actually observed.
   *
   * ★ "OBSERVED" IS THE WHOLE DESIGN, NOT A CAVEAT. The route walks up to 26 weeks of Hive
   * history and stores every act-day it finds, so counting the raw day set would hand a
   * long-standing Hive account ~180 days on its first ever request — rank 7 before it had done
   * anything here, which is exactly what this replaced. So the count is restricted to days at or
   * after `lumen_hive_walk_cursor.first_built_at`: the day Lumen started watching. That is what
   * makes rank 0 true for everybody, veterans included, and it is why this field is named for
   * what was observed rather than for what happened.
   *
   * One day counts once however many times you posted in it, so the arm cannot be farmed faster
   * than the calendar.
   */
  observedActDays: number;
}

/** A step in an arm's table: the smallest value that grants `index`. Ascending. */
export interface ArmStep {
  min: number;
  index: number;
}

/**
 * ENGAGEMENT, in CREDITED distinct givers. THE ARM THAT REPLACED REPUTATION.
 *
 * Calibrated against the credited figures measured live through this route on
 * 2026-08-08 (quoted in hooks/use-retention.ts and credited-givers.ts), not
 * guessed:
 *
 *   blocktrades 1112 · acidyo 543 · arcange 373 · steevc 290 · rafaelaquino 55
 *
 * Landing those on this table: blocktrades → index 7, acidyo/arcange/steevc →
 * index 6, rafaelaquino → index 4, i.e. rafaelaquino earns the public mark, which
 * under the reputation proxy was IMPOSSIBLE for him at any level of engagement
 * (nothing below reputation 61 could reach it). Rung 9 wants 1200 credited givers
 * on top of two years and 23 of 26 weeks, so it stays rare — and, for the first
 * time, reachable.
 *
 * ★ THE MARK IS AT INDEX 4 AND THAT IS THE ANTI-FARM LINE. 40 credited givers is
 * exactly 25 established givers once the unknown budget is accounted for (established
 * + min(unknown, 15)), which is **~1,563 HP** of real stake behind the people who
 * value you. Measured, not estimated — ladder.test.ts §7 asserts the figure, and that
 * assertion is what caught an earlier claim here that it was "~1,500-2,500 HP, MORE
 * expensive than the reputation ladder". It is not uniformly more expensive:
 *
 *   before  500 HP at reputation 88 · 1,190 at 80 · 2,375 at 70 · impossible below 61
 *   after   ~1,563 HP for everybody
 *
 * So the accounts that got the mark most cheaply now pay 3x, the accounts that could
 * never get it now can, and the price stopped depending on a number its holder cannot
 * influence. Do not lower index 4 without redoing that arithmetic.
 */
/**
 * ════ THE ONE ARM: ACTIVE DAYS LUMEN OBSERVED ════
 *
 * ★★ THIS REPLACED THREE ARMS AND A MIN (owner, 2026-08-09: "the ranks need to decay and no one
 * gets rank 7 off the bat. everyone is rank 0, its based off of activity").
 *
 * What was here: ENGAGEMENT_ARM (credited distinct givers), TENURE_ARM (days since HIVE account
 * creation) and ACTIVE_WEEKS_ARM (weeks active in a trailing 26), combined with MIN. Two of the
 * three already decayed, so decay was never really the missing half. The fatal part was the
 * SEEDING: tenure read the Hive chain's account-creation date, so @gtg imported 2016 and
 * saturated that arm on day one, and engagement counted votes on Hive posts, which an
 * established account has by the thousand. Measured live before this change, on their first ever
 * request: gtg, tarazkp and lordbutterfly all landed on **Aurora, rank 8 of 9**; themarkymark and
 * meno on Halo 7. None of them had done anything on Lumen. Meanwhile a newcomer could not reach
 * rung 5 by any amount of effort inside a year, because the tenure arm alone needed 240 days.
 *
 * A ladder you are handed is not a ladder. So the rank now measures ONE thing: distinct days on
 * which this account did something, as OBSERVED BY LUMEN — days at or after
 * `lumen_hive_walk_cursor.first_built_at`, inside a trailing window. Hive history is not
 * imported, which is what makes rank 0 true for everybody on their first day.
 *
 * ★ AND LOSING THE MIN MADE IT HARDER TO FARM, NOT EASIER. The MIN was documented as "the
 * anti-farm heart of the whole feature" and it was, given what it was guarding: a giver count is
 * buyable and Hive age is unearnable, so they needed each other. An act-DAY is neither. It caps
 * at one per calendar day per account no matter how much stake, how many alts or how many posts
 * you bring, and the only way to accumulate 260 of them is to be here on 260 days. There is
 * nothing to buy and no shortcut to sell.
 *
 * ★ DECAY IS THE WINDOW, WITH NO SEPARATE MECHANISM. `ACTIVITY_WINDOW_DAYS` is trailing, so a
 * day drops out of the count a year after it happened. Go quiet and the number falls on its own:
 * no penalty event, no notification, no stored high-water mark, nothing to explain. The owner
 * chose this over an explicit "lose a rung after N quiet weeks" precisely because it needs no
 * machinery and cannot surprise anybody.
 *
 * THE CURVE — calibrated to the owner's answer of "about a year to the top", at roughly five
 * active days a week (~21 a month), with the public mark at rank 5 landing near three months:
 *
 *   rank 1     1 day     first day here
 *   rank 2     5         ~1 week
 *   rank 3    15         ~3 weeks
 *   rank 4    30         ~6 weeks
 *   rank 5    65         ~3 months   <- THE MARK
 *   rank 6   110         ~5 months
 *   rank 7   155         ~7 months
 *   rank 8   200         ~9 months
 *   rank 9   260         ~12 months
 *
 * Index IS the rank now (0..9), so this table needs no off-by-one anywhere.
 */
export const ACTIVITY_ARM: ArmStep[] = [
  { min: 0, index: 0 },
  { min: 1, index: 1 },
  { min: 5, index: 2 },
  { min: 15, index: 3 },
  { min: 30, index: 4 },
  { min: 65, index: 5 },
  { min: 110, index: 6 },
  { min: 155, index: 7 },
  { min: 200, index: 8 },
  { min: 260, index: MAX_TIER_INDEX }
];

/**
 * The trailing window the arm counts over — and therefore the decay rate.
 *
 * A year, so that reaching the top means a year of showing up and holding it means continuing to.
 * Shorter would make the top rung a description of last month; longer would make decay
 * imperceptible and bring back the "handed to you" problem in slow motion.
 */
export const ACTIVITY_WINDOW_DAYS = 365;

/** Saturation point, for the single 0..1 gate meter. */
export const ACTIVITY_SATURATION_DAYS = ACTIVITY_ARM[ACTIVITY_ARM.length - 1].min;

/**
 * The rank at which the public mark appears, derived from the ladder rather than typed twice.
 *
 * ★ ITS PRICE IS NOW STATED IN DAYS, WHICH IS THE POINT. It used to be 40 credited givers, i.e.
 * ~1,563 HP of stake behind the people who valued you — a real cost, but one paid by an audience
 * rather than by the holder, and unreachable for a newcomer whatever they did. It is now 65 days
 * of turning up. Nobody can buy that and nobody starts with it.
 */
export const MARK_TIER_INDEX = TIER_ORDER.findIndex((t) => TIERS[t].showBylineEmblem);

const ARM_UNIT: Record<LeagueArm, LeagueArmUnit> = { activity: 'days' };

export interface ArmPosition {
  arm: LeagueArm;
  index: number;
  /** 0..1 through the current step — how close this arm is to stopping being a constraint. */
  progress: number;
  /**
   * How many more whole units before this arm reaches its next step. `null` on the
   * top step, where there is nothing above. Always at least 1 while a next step
   * exists: a value that has not crossed the edge yet still needs one more unit,
   * and rounding it to 0 would render "0 more people" next to an unfilled bar.
   */
  remaining: number | null;
  unit: LeagueArmUnit;
}

export function armPosition(arm: LeagueArm, steps: ArmStep[], value: number): ArmPosition {
  // NaN (never a real measurement) floors; ±Infinity is left alone so it lands on
  // the top/bottom step, which is what a caller probing the arm's limits means.
  const v = Number.isNaN(value) ? 0 : value;
  const unit = ARM_UNIT[arm];
  let at = 0;
  for (let i = 0; i < steps.length; i++) {
    if (v >= steps[i].min) at = i;
    else break;
  }
  const cur = steps[at];
  const next = steps[at + 1];
  if (!next) return { arm, index: cur.index, progress: 1, remaining: null, unit };
  const span = next.min - cur.min;
  const progress = span > 0 ? (v - cur.min) / span : 1;
  // Ceil, then floor at 1. `Math.ceil` alone returns 0 for a value sitting exactly
  // on the next edge, which cannot happen (it would have advanced `at`), but also
  // for a fractional value within 1 unit of it, which can.
  const remaining = Math.max(1, Math.ceil(next.min - v));
  return { arm, index: cur.index, progress: clamp01(progress), remaining, unit };
}

export function activityBandIdx(observedActDays: number): number {
  return armPosition('activity', ACTIVITY_ARM, observedActDays).index;
}

export function computeLeague(inp: LeagueInputs): LeagueRank {
  const arm = armPosition('activity', ACTIVITY_ARM, Math.max(0, inp.observedActDays));
  const idx = Math.max(0, Math.min(MAX_TIER_INDEX, arm.index));
  const tier = TIER_ORDER[idx];
  const info = TIERS[tier];

  return {
    tier,
    rankNumber: info.order,
    totalRanks: TOTAL_RANKS,
    showBylineEmblem: info.showBylineEmblem,
    bindingArm: arm.arm,
    progressToNext: arm.progress,
    remainingToNext: arm.remaining,
    armUnit: arm.unit,
    // ★ ALWAYS TRUE BELOW THE TOP NOW, and it is not a weakened promise — it is a stronger one.
    // The flag existed because two tied arms meant filling one left the other binding, so
    // "12 more people -> Beacon" could promise a rung the MIN would not deliver. With one arm
    // there is nothing to tie with: the days it names are exactly the days that move the rank.
    nextTierGuaranteed: arm.remaining !== null,
    nextTier: nextTier(tier)
  };
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(1, x));
}
