/**
 * ★ HOW FAR BACK IS THE DAY SET ACTUALLY COMPLETE?
 *
 * `/api/streak/[user]` builds `actDaysUTC` by walking two Hive feeds backwards
 * under a 20-second wall-clock budget and a 25-page cap. Whatever it gets is a
 * NEWEST-FIRST PREFIX of history, never the whole thing — so every statistic
 * derived from it is a measurement only where the prefix reaches, and a LOWER
 * BOUND beyond that.
 *
 * The route already applied this reasoning to `activeWeeks` and got it right. It
 * did NOT apply it to `streakDays`, which stayed in `provenance.exact`
 * unconditionally. Measured live through the shipped route on 2026-08-08:
 *
 *   @acidyo          capped: page_cap     streakDays: 32   exact: [... 'streakDays' ...]
 *                    comments walk reached only 2026-07-13 — SIX DAYS LATER than
 *                    the day the streak supposedly broke. The 32 was a floor.
 *   @taskmaster4450  capped: time_budget  streakDays: 0    exact: [... 'streakDays' ...]
 *
 * ★ WHY THIS IS NOT JUST `capped` REUSED. A blanket "capped ⇒ inexact" would be
 * safe but wrong in the useful direction: it marks a two-day streak inexact on a
 * walk that read six months, understating a number we can actually prove. The
 * real question is narrower — did the streak BREAK inside the part we read? If
 * yes, the break is observed and `streakDays` is exact even on a capped walk.
 *
 * Lives in its own module, not inline in the route, for the same reason
 * `credited-givers.ts` does: a Next App Router route module may only export HTTP
 * method handlers, so anything left inside one is untestable by construction, and
 * this is date arithmetic on a boundary condition — precisely the kind of code
 * that is wrong until a test says otherwise.
 */

/** The subset of the route's FeedWalk this needs. */
export interface WalkCoverage {
  /** True when the page cap, a failed call or the clock stopped the walk early. */
  capped: boolean;
  /** Oldest item actually seen, as a UTC 'YYYY-MM-DD' day. '' when none. */
  oldestDayUTC: string;
}

/**
 * The oldest UTC day for which the merged day set is COMPLETE.
 *
 * `''` means nothing bounded the walks — every day inside the window was read.
 * Otherwise every day strictly older than the returned day may be missing acts.
 *
 * The LATEST of the individual boundaries wins, because the merged day set is
 * only complete where EVERY contributing feed is complete: one feed that stopped
 * last week leaves holes last week even if the other reached 2019.
 *
 * A walk that was bounded but read NOTHING (`oldestDayUTC === ''`) covers no day
 * at all, so its boundary is `todayUTC` — not `''`, which would drop it from the
 * comparison and silently upgrade "we read none of your history" to "exact".
 */
export function daySetCompleteFrom(walks: WalkCoverage[], todayUTC: string): string {
  let boundary = '';
  for (const w of walks) {
    if (!w.capped) continue;
    const b = w.oldestDayUTC || todayUTC;
    if (b > boundary) boundary = b;
  }
  return boundary;
}

// ★ `isStreakLowerBound` IS DELETED (2026-08-18). It took `computeStreak`'s BREAK DAY —
// the first day going backwards with no act — and compared it against the boundary above
// to decide whether the streak was exact. The streak decays now: it accumulates FORWARD
// and has no break day at all, so the question has no subject. `computeStreak` decides the
// floor itself, by comparing the day it counted from against the day Lumen started
// counting the account, and `daySetCompleteFrom` above is what supplies the first of those
// two. One boundary, still computed here, still tested.
