'use client';

/**
 * ════ THE DAILY GOAL ════
 *
 * Duolingo's pattern, and the reason it is their pattern: the person picks their own
 * bar. A goal you chose is a commitment; a goal we chose for you is a quota, and this
 * product's whole argument is that we do not hand the reader chores.
 *
 * ★ THE GOAL IS A PREFERENCE AND LIVES CLIENT-SIDE. IT MEASURES NOTHING.
 *
 * The number of acts you did today is chain-derived and served by the route
 * (`summary.today.acts`), so PROGRESS is unforgeable. What is stored here is only
 * which bar you asked to be measured against — editing it in localStorage changes
 * the ring you look at and nothing else: not the streak, not the rank, not the mark.
 * That split is the same anti-farm architecture the rest of the feature uses, applied
 * to the one piece that genuinely is cosmetic.
 *
 * Storage goes through storage-with-ttl (never raw localStorage) per the repo rule.
 * PERMANENT, because a preference that silently expires and resets somebody's chosen
 * goal to the default is worse than no preference at all.
 *
 * ★ ONE HONEST LIMITATION, STATED: this is per-browser, so the goal does not follow
 * the reader to another device. Putting it on the server means a column on
 * `lumen_hive_reader_prefs` and a write route, which is worth doing once the loop has
 * proven it earns its keep — it is not worth blocking the loop on.
 */

export type DailyGoalId = 'casual' | 'regular' | 'serious';

export interface DailyGoal {
  id: DailyGoalId;
  /** Authored acts (posts + comments) needed to tick the streak today. */
  target: number;
}

/**
 * Deliberately small numbers, and deliberately only three of them.
 *
 * ONE act is a real option, not a joke option: the streak exists to bring somebody
 * back tomorrow, and a bar high enough to fail is a bar that stops them coming back.
 * FOUR is the top because the currency is posts and comments — a goal of ten would be
 * asking for volume, and volume is the thing this ladder pointedly does not reward.
 */
export const DAILY_GOALS: Record<DailyGoalId, DailyGoal> = {
  casual: { id: 'casual', target: 1 },
  regular: { id: 'regular', target: 2 },
  serious: { id: 'serious', target: 4 }
};

export const DAILY_GOAL_ORDER: DailyGoalId[] = ['casual', 'regular', 'serious'];

/**
 * The default is the SMALLEST goal, on purpose. A person who never opens the picker
 * should be measured against the easiest bar, not a middling one they did not choose
 * and will quietly fail.
 */
export const DEFAULT_DAILY_GOAL: DailyGoalId = 'casual';

// ★ THE STORAGE HALF OF THIS FILE IS GONE (2026-08-09).
//
// `readDailyGoal` / `writeDailyGoal` / the localStorage key were deleted when the goal
// started gating the streak. The reasoning that justified client storage is quoted above
// and it was correct WHILE the goal measured nothing — the moment it decides whether today
// counts toward a chain-derived streak, a client-held value would hand a reader their own
// streak from a devtools console.
//
// The value now lives in `lumen_retention_goal` (migration 0029), is read and written
// through `/api/retention/goal`, and reaches the card as `summary.today.goal` — the same
// number the server judged the streak against, so the ring cannot disagree with it.
//
// What remains here is the TIER TABLE, which is presentation: the three offered targets
// and their labels. That belongs on the client.
