/**
 * ════ WHICH SENTENCE, AND WHY ════
 *
 * Two branch selections pulled out of components so they can be tested. Both were written
 * inside JSX first, and both have a case that is only reachable in states a browser session
 * does not casually produce — a streak of zero, a reach figure that fell — which is exactly
 * the kind of branch that ships wrong and is never noticed.
 *
 * These functions choose a KEY. They do no translation and hold no copy.
 */

export interface TodayState {
  /** Acts done today already meet the goal. */
  met: boolean;
  /** The chain-derived streak, which can legitimately be 0. */
  streakDays: number;
  /** The reader's committed goal, >= 1. */
  goal: number;
}

export interface TodayHeadline {
  key: string;
  vars: { days?: number; goal?: number };
}

/**
 * The one line at the top of the daily card.
 *
 * ★★ TWO BUGS LIVED IN THE SINGLE LINE THIS REPLACED (2026-08-09).
 *
 * It was unconditionally `retention.today.holds` with `{ days: streakDays }`, rendering
 * "Day {{days}} holds until midnight UTC":
 *
 *  1. THE GOAL GATES THE STREAK AND THE SENTENCE NEVER SAID SO. The wording was written
 *     while the goal was cosmetic and was not revisited when it started deciding whether
 *     today counts. A tester picked "Serious" (4/day) out of curiosity, watched the ring
 *     go 0/1 -> 0/4, and read a sentence still promising the day "holds": "I could lose a
 *     streak to a setting I picked casually." A gate the reader cannot see is a trap.
 *  2. "DAY 0 HOLDS" WAS REACHABLE. Any account with no acts in the current run has
 *     `streakDays === 0`, which is every returning reader on their first day back, and
 *     they were told day zero was holding until midnight.
 */
export function todayHeadline({ met, streakDays, goal }: TodayState): TodayHeadline {
  if (met) return { key: 'retention.today.done', vars: {} };
  const target = Math.max(1, Math.floor(goal));
  // No streak yet: name what STARTS one. Nothing "holds".
  if (streakDays <= 0) {
    return target > 1
      ? { key: 'retention.today.start_goal', vars: { goal: target } }
      : { key: 'retention.today.start', vars: {} };
  }
  // A streak exists: name the day today would BECOME, and what it costs.
  //
  // ★★ THE DAY NUMBER WAS OFF BY ONE, AND IT MADE THE CARD CONTRADICT ITSELF (found
  // 2026-08-09 by a UX agent reading the whole card at once, verbatim: "The streak is either
  // already 2 or not yet 2").
  //
  // `streakDays` is the run counted BACKWARDS FROM TODAY, and `computeStreak` steps the cursor
  // back a day when today has no act or has not met the goal. So for a reader with nothing yet
  // today, `streakDays === 2` means yesterday and the day before — both already banked, one of
  // them by a freeze. Rendering "Day 2 holds when you reach 4 today" therefore put a number on
  // the card that the flame beside it was ALSO showing ("2-day streak"), while asking the
  // reader to earn it. Two different claims about the same integer, six words apart.
  //
  // Today is `streakDays + 1`. Naming the day they are about to REACH is both honest and the
  // more motivating half: the flame reports what is banked, the headline reports what is next,
  // and the two numbers now differ because they mean different things.
  // ★★★ NO "Day N lands if you post today" (owner ruling, 2026-08-11). The same
  // sentence was removed from the above-feed nudge for the same reason: it is a
  // deadline the reader did not ask for. The card states the goal WITHOUT attaching a
  // day number to it, so it reports what today needs instead of what a streak costs.
  return target > 1
    ? { key: 'retention.today.goal_only', vars: { goal: target } }
    : { key: 'retention.today.open', vars: {} };
}

export interface ReachTrend {
  /** '' when no direction may be claimed. Otherwise a delta key. */
  key: string;
  /** Always positive: the key carries the direction, the number carries the size. */
  count: number;
}

/**
 * Whether this week's reach may be stated as a direction, and which way.
 *
 * ★ A MISSING OR ZERO PREVIOUS WINDOW IS NOT A TREND. `lumen_feed_served` only holds rows
 * from the day it started filling, so "0 last week" means EITHER this account reached
 * nobody OR nothing was being recorded — and those license opposite claims. The route
 * publishes `feedsReachedPrev` only above zero; this refuses to draw anything without it.
 * Same guard, same reason, as `newPeopleIsTrustworthy`: on a young install every account
 * looks like it is exploding.
 *
 * A flat week returns '' as well. "The same as last week" was drafted, then cut: it is
 * three strings of copy to report an absence of news.
 */
export function reachTrend(current: number, prev: number | undefined): ReachTrend {
  if (typeof prev !== 'number' || prev <= 0) return { key: '', count: 0 };
  const delta = current - prev;
  if (delta === 0) return { key: '', count: 0 };
  return delta > 0
    ? { key: 'retention.stats.feeds_delta_up', count: delta }
    : { key: 'retention.stats.feeds_delta_down', count: -delta };
}
