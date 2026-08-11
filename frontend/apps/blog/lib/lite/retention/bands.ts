import {
  ACTIVITY_ARM,
  armPosition as sharedArmPosition,
  type ArmPosition,
  type ArmStep
} from '@/blog/features/retention/lib/compute-league';
import { MAX_TIER_INDEX } from '@/blog/features/retention/lib/tiers';
import type { LeagueArm } from '@/blog/features/retention/types';

export type { ArmPosition, ArmStep };

/**
 * The LUMEN-NATIVE arms of the ladder — the same three keystones and the same
 * `Math.min` composition as `features/retention/lib/compute-league.ts`, on a ruler
 * calibrated to the timescale a lite account actually lives on.
 *
 * ★ WHY A SECOND RULER EXISTS AT ALL.
 *
 * The chain arms are calibrated on Hive: first tenure step at 14 days, top at 730;
 * presence counted in weeks out of a trailing 26. Pointed at Lumen's own database
 * those numbers do not measure anything. MEASURED on the live QA database
 * (2026-08-08): 176 lite accounts, every one created inside the last 48 hours; 88
 * user-days spread over THREE calendar days; 84 of the 86 accounts with any activity
 * have exactly one active day. Under the chain arms all 176 sit on rung 1 (Void) and
 * CANNOT LEAVE IT FOR TWO WEEKS whatever they do. That ladder is honest and useless:
 * an arm returning one value for the entire population is not measuring the
 * population, and a rank that cannot move for a fortnight is indistinguishable from
 * having no rank — which is the state lite users are in today.
 *
 * WHAT IS RESCALED: the step tables below, and nothing else.
 * WHAT IS NOT: the composition. The rung is still MIN over the three arms, the
 * weakest arm still pins you, and received engagement is still the arm you cannot
 * supply yourself. Softening the ruler must never soften the gate — so the
 * engagement arm here is bounded harder than the chain one (see `credit-givers.ts`),
 * not more loosely.
 *
 * Every edge is an operator-tunable constant. The `ArmStep` shape is deliberately the
 * same as compute-league.ts's private one so that band boundary and progress-within-band
 * come from ONE table and cannot drift apart, and so `bindingArm` / `progressToNext`
 * mean exactly the same thing on both paths.
 */

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * TENURE, in days.
 *
 *   chain:  14 · 30 · 90 · 180 · 365 · 730
 *   lumen:   1 ·  3 ·  7 ·  14 ·  30 ·  60 · 120 · 240
 *
 * Same geometric shape — each edge roughly doubles the last, so every promotion costs
 * about as much waiting as all the promotions before it — but the compression is
 * deliberately NOT uniform:
 *
 *   * At the BOTTOM it is aggressive (14 days -> 1 day, 14x). This is where the dead
 *     zone was. Someone who signs up and comes back tomorrow now moves. The chain's
 *     ENTIRE first step (14 days) spans Lumen's first FOUR rungs, so a lite user's
 *     first fortnight contains four promotions instead of one. That is the fix.
 *   * At the TOP it is mild (730 -> 240 days, ~3x). The apex is meant to be scarce and
 *     to cost real, uncompressible calendar time. Lumen being young does not make eight
 *     months of tenure cheap. Rescaling a floor nobody can leave is a fix; rescaling
 *     the ceiling by the same factor would just be inflation.
 *
 * Consequence, stated plainly: nobody reaches index 8 on this arm until their account
 * is 240 days old, which no account is. Correct. The bug was a floor nobody could
 * leave, not a ceiling nobody has reached yet.
 */
/**
 * ════ THE LITE LADDER USES THE SHARED ACTIVITY ARM NOW (owner, 2026-08-09) ════
 *
 * This file held three arms of its own — TENURE_ARM (days since the Lumen account was created),
 * PRESENCE_ARM (active days in a 60-day window) and ENGAGEMENT_ARM (credited givers, floored at
 * index 2 so a lite account was never told nobody had found it) — plus their saturation points
 * and three wrapper helpers, all env-tunable at "Lumen scale".
 *
 * All of it is deleted. "no one gets rank 7 off the bat. everyone is rank 0, its based off of
 * activity" is not a chain-path rule, it is the rank's DEFINITION, and two ladders with different
 * definitions cannot share a rank number — which they must, because `lumen_hive_rank` stores one
 * and the byline mark renders it beside Hive authors and lite authors in the same feed. A lite
 * rank 5 and a chain rank 5 have to have cost the same thing.
 *
 * So both ladders now read `ACTIVITY_ARM` from features/retention/lib/compute-league.ts: distinct
 * active days inside a trailing year. A lite account needs no observation gate — Lumen created it,
 * so every day of its history was observed by definition, which is why this path passes its day
 * count straight through while the chain path has to filter on `first_built_at`.
 *
 * ★ THE ENGAGEMENT FLOOR GOES WITH IT, AND ITS PROBLEM IS SOLVED RATHER THAN MOVED.
 * `ENGAGEMENT_FLOOR_INDEX` existed because a brand-new lite account has no givers, and a
 * giver-driven arm would have pinned it at the bottom rung through no fault of its own. With the
 * rank driven by activity, a new account is rank 0 because it has not done anything yet — which
 * is honest, temporary, and true of every account including a ten-year Hive veteran.
 */

/**
 * Kept because `facts-query.ts` and the presence stat both window on it, and because the lite
 * path reports "active N of the last M days" in its detail block. It is no longer an ARM.
 */
export const PRESENCE_WINDOW_DAYS = envNum('LITE_RETENTION_PRESENCE_WINDOW_DAYS', 60);
export const PRESENCE_WINDOW_WEEKS = Math.max(1, Math.ceil(PRESENCE_WINDOW_DAYS / 7));

export function armPosition(arm: LeagueArm, steps: ArmStep[], value: number): ArmPosition {
  return sharedArmPosition(arm, steps, value);
}

/**
 * The one arm, shared with the chain ladder.
 *
 * `activeDays` is passed straight through with no observation gate: Lumen created this account,
 * so every day in its history is a day Lumen watched. The chain path cannot make that assumption
 * and filters on `first_built_at` — see deriveLeagueInputs.
 *
 * ★ CALLERS MUST PASS THE ACTIVITY_WINDOW_DAYS-WINDOWED COUNT (365), NOT THE
 * PRESENCE_WINDOW_DAYS one (60) above. Those are two different spans for two different jobs —
 * this is the arm the RANK is built on, PRESENCE_WINDOW_DAYS is only the "active N of the last
 * M days" UI stat — and feeding this function the shorter span is exactly the bug that made
 * ranks 5-9 unreachable (fixed 2026-08-11 in facts-query.ts / compute.ts). See
 * `RetentionFacts.activeDaysInActivityWindow`.
 */
export function activityArmPosition(activeDays: number): ArmPosition {
  return armPosition('activity', ACTIVITY_ARM, Math.max(0, Math.floor(activeDays)));
}

