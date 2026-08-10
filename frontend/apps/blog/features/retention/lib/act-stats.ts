/**
 * ════ THE INTERESTING NUMBERS ════
 *
 * Pure derivations over data the retention route ALREADY WALKS. Nothing here costs
 * an extra API call; every function below reads the same two feed walks and the
 * same vote sample that the rank is computed from.
 *
 * ★ WHY THIS FILE EXISTS AT ALL. The route summed `totalVotesOnSample`, passed it
 * into `deriveLeagueInputs`, and `deriveLeagueInputs` never read it. Same for
 * `sampledPosts`. The system knew how many votes an account had received and how
 * many posts it had published and it displayed neither, while the profile showed
 * three abstract percentage meters instead. These are the numbers that were on the
 * floor.
 *
 * It is a module and not inline in the route for the usual reason: a Next App
 * Router route module may only export HTTP handlers, and an off-by-one in a
 * weekday index or a streak run is exactly the sort of thing that is wrong until a
 * test says otherwise.
 *
 * HONESTY: every function here reports over WHAT WAS READ. The walks stop on a
 * clock, so `longestRun` and `busiestWeekday` are statements about the history the
 * route actually saw, and the route publishes `coverage.capped` alongside them. A
 * floor is fine. A floor presented as a total is not.
 */

// `PostStatsLike` went with them. It existed to name `stats.total_votes`, and nothing
// left in this file reads a post at all — the two survivors take a set of UTC day strings.

/**
 * ════ THE VOTE-AMOUNT DERIVATIONS ARE DELETED (owner ruling, 2026-08-09) ════
 *
 * `PostEngagement`, `postEngagement()` and `postsWithRealEngagement()` lived here and
 * produced four numbers the profile printed: votes received, best post, and "N of the
 * last M posts got engagement". All four are gone, and the reasoning is worth keeping
 * because the file used to argue the opposite very confidently.
 *
 * ★ "vote amounts dont matter, theyre all botted." Curation trails, vote-selling
 * services and auto-voters mean a Hive vote total measures who has subscribed to whose
 * trail, not who read anything. This file called votes-received "the numbers that were
 * on the floor"; they were on the floor because they are not worth picking up.
 *
 * ★ AND A WINDOWED COUNT OF VOTES OR COMMENTS MAY NOT BE PRINTED AT ALL: "you cant list
 * votes and comments and not have it for all time. if thats the case then drop it." The
 * route reads a bounded feed walk under a wall-clock budget, so an all-time total is not
 * available at any price on this path — which makes "drop it" the only honest branch.
 *
 * ★ `postsWithRealEngagement` was a FIX to a tautology, and it still could not vary. It
 * was added the same day to stop the author's own self-vote satisfying "got engagement".
 * That removed the tautology from the numerator and left the sample untouched: the sample
 * is the 8 MOST RECENT posts, and on a chain with curation trails those all have a
 * non-author voter, so it read N of N on 5 of 5 accounts a tester checked (2/2, 6/6, 8/8,
 * 4/4, 8/8). A line that cannot come out any other way is not a measurement.
 *
 * WHAT REPLACED THEM: a headcount of distinct people with the global blacklist and the
 * engagement exclusion list applied at the source (`lib/moderation/engagement-exclusions.ts`).
 * Not an amount, not farmable by volume, and it names its own scope in its own sentence.
 *
 * DO NOT REINTRODUCE A VOTE TOTAL HERE. If a future surface wants one, the question to
 * answer first is "over all time, or not at all".
 */

/**
 * The longest run of consecutive UTC days with an act, anywhere in the day set.
 *
 * Distinct from `computeStreak().streakDays`, which is the run ending TODAY. This
 * is the personal record, and it is the one worth showing when the current streak
 * is 0: "longest streak: 32 days" is a fact about you, while "0-day streak" is a
 * fact about this week.
 */
export function longestRun(actDaysUTC: string[]): number {
  const days = [...new Set(actDaysUTC.filter(Boolean))].sort();
  if (days.length === 0) return 0;

  let best = 1;
  let run = 1;
  for (let i = 1; i < days.length; i++) {
    // Compare by epoch day rather than by string arithmetic: '2026-03-01' follows
    // '2026-02-28' only in a leap year, and month/year boundaries are exactly where
    // a hand-rolled string increment goes wrong.
    const prev = Date.parse(`${days[i - 1]}T00:00:00Z`);
    const cur = Date.parse(`${days[i]}T00:00:00Z`);
    if (!Number.isFinite(prev) || !Number.isFinite(cur)) continue;
    run = cur - prev === 86_400_000 ? run + 1 : 1;
    if (run > best) best = run;
  }
  return best;
}

// `weekdayCounts` lived here — seven per-weekday counts with no pattern claim attached, built
// so a daily question could compare three named days without needing a real habit to exist. The
// question mechanics were removed on 2026-08-09 ("too unserious"), and nothing else read it:
// `busiestWeekday` below counts its own days because it also applies MIN_LIFT.

/**
 * The longest stretch of consecutive days with NO act, inside the day set.
 *
 * The mirror of `longestRun`, and a far more interesting fact: everybody has a rough idea
 * of their best streak and nobody knows their longest silence. Measured BETWEEN the first
 * and last active day only — a gap needs both edges to be a gap, and counting from "the
 * dawn of the account" or "up to today" would turn a new account's whole life into one
 * enormous silence.
 *
 * ★ ONLY MEANINGFUL WHEN THE HISTORY IS COMPLETE. The feed walks stop on a clock, so a
 * missing day may be a hole in what was READ rather than a day nobody posted — the exact
 * failure `streakDaysIsLowerBound` exists for. The caller gates on
 * `coverage.historyComplete`; this function just measures what it is given.
 */
export function longestGap(actDaysUTC: string[]): number {
  const days = [...new Set(actDaysUTC.filter(Boolean))].sort();
  if (days.length < 2) return 0;
  let best = 0;
  for (let i = 1; i < days.length; i++) {
    const prev = Date.parse(`${days[i - 1]}T00:00:00Z`);
    const cur = Date.parse(`${days[i]}T00:00:00Z`);
    if (!Number.isFinite(prev) || !Number.isFinite(cur)) continue;
    // Days strictly BETWEEN the two actives. Consecutive days are a gap of 0.
    const gap = Math.round((cur - prev) / 86_400_000) - 1;
    if (gap > best) best = gap;
  }
  return best;
}

export interface WeekdayPattern {
  /** 0 = Sunday … 6 = Saturday, in UTC. */
  weekday: number;
  /** Acts recorded on that weekday, so the claim is checkable. */
  acts: number;
}

/**
 * The weekday this account acts on most.
 *
 * ★ IT MUST BE A REAL PATTERN, NOT AN ARGMAX OVER NOISE. Any non-empty day set has
 * a maximum, so an unconditional argmax will confidently tell an account with four
 * total acts that it "posts most on Tuesdays". Two guards:
 *   - at least MIN_ACTS_FOR_PATTERN days of history, and
 *   - the winner must beat an even spread by MIN_LIFT, so a flat poster gets no
 *     claim rather than an arbitrary one.
 * Returns null when there is no pattern, and null renders no line.
 */
export const MIN_ACTS_FOR_PATTERN = 14;
export const MIN_LIFT = 1.5;

export function busiestWeekday(actDaysUTC: string[]): WeekdayPattern | null {
  const days = [...new Set(actDaysUTC.filter(Boolean))];
  if (days.length < MIN_ACTS_FOR_PATTERN) return null;

  const counts = [0, 0, 0, 0, 0, 0, 0];
  let total = 0;
  for (const d of days) {
    const ms = Date.parse(`${d}T00:00:00Z`);
    if (!Number.isFinite(ms)) continue;
    counts[new Date(ms).getUTCDay()] += 1;
    total += 1;
  }
  if (total < MIN_ACTS_FOR_PATTERN) return null;

  let weekday = 0;
  for (let i = 1; i < 7; i++) if (counts[i] > counts[weekday]) weekday = i;

  const evenSpread = total / 7;
  if (counts[weekday] < evenSpread * MIN_LIFT) return null;
  return { weekday, acts: counts[weekday] };
}
