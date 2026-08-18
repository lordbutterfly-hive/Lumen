/**
 * ════ WHICH SENTENCE, AND WHY ════
 *
 * A branch selection pulled out of a component so it can be tested. It was written inside
 * JSX first, and it has a case that is only reachable in a state a browser session does not
 * casually produce — a reach figure that FELL — which is exactly the kind of branch that
 * ships wrong and is never noticed.
 *
 * This function chooses a KEY. It does no translation and holds no copy.
 */

// ★ `todayHeadline` AND `TodayState` ARE DELETED (2026-08-18, owner).
//
// They chose between four sentences for the daily card ("Done for today.", what STARTS a
// streak, what HOLDS one, and the chosen goal restated) — a selector that existed because
// the card had a per-day GOAL to describe. The goal is gone and the card states one rule
// that does not branch, so there is nothing left to select. `reachTrend` below is the only
// selector this file still owns.

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
