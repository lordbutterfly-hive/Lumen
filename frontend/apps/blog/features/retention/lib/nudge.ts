/**
 * ════ THE IN-APP NUDGE — A RANKED SELECTOR OVER FACTS, NOT AN ENCOURAGEMENT ════
 *
 * Owner ruling, 2026-08-09: web push is parked (no manifest, no service worker, no
 * VAPID keys in the repo, and iOS only delivers it to an installed home-screen PWA);
 * build the in-app nudge instead, "fun and sophisticated".
 *
 * ★ WHAT MAKES IT SOPHISTICATED IS THAT IT CAN SAY NOTHING.
 *
 * This is a priority list evaluated against things we already measured. It takes the
 * highest-ranked candidate that is TRUE TODAY and INTERESTING, and if none qualifies
 * it returns null and the surface renders nothing. **There is deliberately no
 * fallback string.** A fallback is exactly how a nudge becomes a nag: the moment the
 * system must say something every day, it starts saying "you haven't posted today",
 * and then it is a chore reminder wearing a friendly voice. Silence is a valid and
 * common output.
 *
 * ★ AND IT NEVER APPLIES PRESSURE. Rejected on purpose, permanently: "Keep your
 * streak going!", any countdown clock, any exclamation mark, anything that reads as
 * loss aversion, and anything at all about a rank going down. The freeze mechanic
 * exists so that a missed day is designed in — a nudge that panics about a missed day
 * contradicts the system it is advertising. `streak_holds` states the deadline as a
 * fact and mentions the mercy in the same breath.
 *
 * Pure: no React, no i18n, no DOM, no clock of its own. The caller supplies today's
 * weekday and the component owns the once-per-day ledger, so every rule below is
 * unit-testable.
 */

/** Which line to print. The order of this union is the priority order. */
export type NudgeKind =
  | 'new_giver'
  | 'unanswered'
  | 'milestone'
  | 'reach'
  | 'weekday_today'
  | 'new_people_week'
  | 'streak_holds';

export interface NudgeFacts {
  /** Consecutive days with an authored act, from the chain-derived streak. */
  streakDays: number;
  /** True when the streak is a floor — do not celebrate a milestone we cannot prove. */
  streakIsLowerBound: boolean;
  /** Authored acts today. Zero is what makes several candidates relevant. */
  actsToday: number;
  freezesAvailable: number;
  /** 0 = Sunday … 6 = Saturday, in the READER's local week. */
  todayWeekday: number;
  /** The weekday this account acts on most, when there is a real pattern. */
  busiestWeekday?: number;
  /** Distinct people who have engaged. */
  people?: number;
  /** People who engaged for the first time inside the last week. */
  newPeopleThisWeek?: number;
  /** The most recent first-time giver, when we know which one. */
  firstTimeGiverName?: string;
  /** Distinct feeds the last posts landed in. */
  feedsReached?: number;
  /** A reply TO this reader that nobody has answered. */
  unansweredReply?: { author: string; ago: string };
}

export interface Nudge {
  kind: NudgeKind;
  /** Interpolation values for the kind's translation key. */
  vars: Record<string, string | number>;
}

/**
 * Streak lengths worth remarking on.
 *
 * Deliberately sparse and deliberately front-loaded: day 2 and day 3 are where
 * retention curves actually bend, and after day 100 the interesting number is a
 * round one rather than every increment. A milestone on every single day is not a
 * milestone, it is a daily notification.
 */
export const STREAK_MILESTONES = [2, 3, 7, 14, 30, 50, 100, 200, 365];

/** A month or more reads differently from a week, and gets its own line. */
export const MONTH_MILESTONE = 30;

/**
 * Reach is only worth mentioning when it is a number somebody would repeat. Below
 * this it reads as a disappointing statistic rather than a fact worth knowing, and
 * we are not in the business of volunteering those.
 */
export const MIN_REACH_TO_MENTION = 25;

export function selectNudge(facts: NudgeFacts): Nudge | null {
  // 1. SOMEBODY NEW FOUND YOU. The best thing this system can tell anyone, and
  //    nothing on Hive tells you it. Needs a name — an anonymous "1 new person" is a
  //    statistic, "@tarazkp read you for the first time" is an event.
  if (facts.firstTimeGiverName && typeof facts.people === 'number' && facts.people > 0) {
    return {
      kind: 'new_giver',
      vars: { name: facts.firstTimeGiverName, count: facts.people }
    };
  }

  // 2. A CONVERSATION IS UNFINISHED. The opposite of "you have 1 notification": it
  //    says what is actually outstanding, which is the only kind of reminder worth
  //    interrupting somebody for.
  if (facts.unansweredReply) {
    return {
      kind: 'unanswered',
      vars: { name: facts.unansweredReply.author, ago: facts.unansweredReply.ago }
    };
  }

  // 3. A MILESTONE, but never one we cannot prove. `streakIsLowerBound` means the
  //    walk stopped before the streak did, so the number is a floor — congratulating
  //    somebody on day 30 when we only know it is "at least 30" is a guess with
  //    confetti on it.
  if (!facts.streakIsLowerBound && STREAK_MILESTONES.includes(facts.streakDays)) {
    return {
      kind: 'milestone',
      vars: { days: facts.streakDays, month: facts.streakDays >= MONTH_MILESTONE ? 1 : 0 }
    };
  }

  // 4. REACH. A fact about where the work went, which is the thing creators on Hive
  //    have never been able to see.
  if (typeof facts.feedsReached === 'number' && facts.feedsReached >= MIN_REACH_TO_MENTION) {
    return { kind: 'reach', vars: { count: facts.feedsReached } };
  }

  // 5. THE PATTERN. Only on the day it is about, and only when nothing has been
  //    written yet — on any other day it is trivia, and after you have posted it is a
  //    statement of the obvious. This is the one that proves the whole idea: specific,
  //    true, funny, and it asks for nothing.
  if (
    typeof facts.busiestWeekday === 'number' &&
    facts.busiestWeekday === facts.todayWeekday &&
    facts.actsToday === 0
  ) {
    return { kind: 'weekday_today', vars: { weekday: facts.busiestWeekday } };
  }

  // 6. NEW PEOPLE, in aggregate, when we have no single name to point at.
  if (typeof facts.newPeopleThisWeek === 'number' && facts.newPeopleThisWeek > 0) {
    return { kind: 'new_people_week', vars: { count: facts.newPeopleThisWeek } };
  }

  // 7. THE STREAK, STATED FLAT. Only with a real run going, only before anything has
  //    been written today, and only when a freeze is banked — so the sentence can
  //    carry the mercy alongside the deadline instead of just the deadline. Without a
  //    freeze to mention this is a bare countdown, which is the thing we refuse to
  //    send.
  //    ★ `streakDays + 1`, THE SAME OFF-BY-ONE THE CARD HAD. `actsToday === 0` is checked one
  //    line up, so the run cannot include today: the day being talked about is the NEXT one.
  //    The card said "Day 2 lands" beside a flame reading "2-day streak"; this said it too.
  if (facts.streakDays >= 2 && facts.actsToday === 0 && facts.freezesAvailable > 0) {
    return {
      kind: 'streak_holds',
      vars: { days: facts.streakDays + 1, freezes: facts.freezesAvailable }
    };
  }

  // Nothing true and interesting today. Say nothing.
  return null;
}
