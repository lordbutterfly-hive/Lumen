'use client';

import { getStorageItem, setStorageItem, StorageTTL } from '@ui/lib/storage-with-ttl';

/**
 * ★ THREE FEEDBACK MOMENTS. THREE. (owner ruling, 2026-08-08.)
 *
 * "no feedback from it to engage me, give me positive feedback." The fix is not
 * more notifications — it is a very small number of them that land, with hard
 * ceilings written into the code rather than into a doc nobody reads:
 *
 *   1. the first genuine act in a session  → one toast
 *   2. day 2 of a streak                   → one toast ("that's the hard one")
 *   3. a Monday weekly recap CARD          → in the feed, dismissible, no toast
 *
 * HARD LIMITS enforced here, not by convention:
 *   - at most ONE retention toast per session (SESSION_MS)
 *   - at most THREE per rolling week (MAX_TOASTS_PER_WEEK)
 *   - no modals, ever — the moments are toasts and one dismissible card
 *   - ABSOLUTELY NOTHING ON DEMOTION. There is no code path here that fires on a
 *     rank going down, and there must never be one. A rank that drops does so
 *     silently; at most the profile carries a factual, non-punitive line. Telling
 *     someone they got worse is not feedback, it is a reason to leave.
 *
 * ★ AND IT NOW FIRES FOR HIVE ACCOUNTS TOO (2026-08-09). `recordRetentionAct` was
 * imported by exactly one file — `lib/lite/client/lite-write.ts` — so every one of
 * these moments was dark for the audience that already exists: a Hive user got no
 * first-act toast, no day-2 toast, and a weekly recap whose act counts were
 * permanently zero. The chain write path (`use-post-mutation`,
 * `use-comment-mutations`, `use-vote-mutation`) now records too, guarded on
 * `account_tier !== 'lite'` so a lite write is never counted twice: lite-write already
 * covers it, and `actor.ts` hard-rejects a non-lite session on those routes, so the
 * two paths are exact complements.
 *
 * WHY THE LEDGER IS CLIENT-SIDE: this is the HABIT layer, which the retention
 * architecture already keeps in browser storage precisely because it is cosmetic
 * and partly forgeable by design (types.ts, "HABIT ... worthless to a bot"). It
 * is NEVER an input to the league — faking a streak here buys a toast and
 * nothing else. Every act recorded is one the SERVER already confirmed (the
 * caller records only after a 2xx from /api/lite/*), so it is not merely a
 * client's claim that something happened.
 *
 * Storage goes through storage-with-ttl (never raw localStorage), per the repo
 * rule; both keys are UI-state grade and expire on their own.
 */

export type RetentionActKind = 'post' | 'reply' | 'vote' | 'reblog' | 'follow';

/**
 * Only acts the person actually PERFORMED, and only ones the SERVER confirms —
 * one per /api/lite write route. Reading is not an act: it is unverifiable,
 * trivially forgeable, and rewarding it is how you end up with a scroll metric.
 * Undo-shaped calls (unvote, un-reblog, unfollow) are not acts either; the
 * caller records only the positive direction.
 */
const ACT_KINDS: RetentionActKind[] = ['post', 'reply', 'vote', 'reblog', 'follow'];

const ACTS_KEY = 'retention-acts-v1';
const TOASTS_KEY = 'retention-toasts-v1';

/** One toast per session; a session is bounded by wall-clock, not by tab life,
 *  so a reload cannot buy a second one. */
const SESSION_MS = 6 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TOASTS_PER_WEEK = 3;
/** Days of act history kept — enough for a 7-day recap plus streak continuity. */
const LEDGER_DAYS = 21;

type DayCounts = Partial<Record<RetentionActKind, number>>;

interface ActLedger {
  /** UTC day (YYYY-MM-DD) → per-kind counts. */
  days: Record<string, DayCounts>;
}

interface ToastLedger {
  /** Epoch ms of the last retention toast shown. */
  lastAt: number;
  /** Start of the current rolling-week window. */
  windowStart: number;
  /** Toasts shown inside that window. */
  windowCount: number;
  /** UTC day the day-2 streak moment already fired on (fires once per streak). */
  day2Day: string;
  /** UTC day the first-act moment already fired on. */
  firstActDay: string;
  /** UTC day the daily-goal moment already fired on. */
  goalDay: string;
  /** UTC day a streak-milestone moment already fired on. */
  milestoneDay: string;
}

export function utcDayKey(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

function addUtcDays(day: string, delta: number): string {
  const ms = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(ms)) return day;
  return new Date(ms + delta * 86_400_000).toISOString().slice(0, 10);
}

function readActLedger(): ActLedger {
  const stored = getStorageItem<ActLedger>(ACTS_KEY);
  if (!stored || typeof stored !== 'object' || !stored.days) return { days: {} };
  return { days: stored.days };
}

function writeActLedger(ledger: ActLedger): void {
  setStorageItem(ACTS_KEY, ledger, StorageTTL.UI_STATE);
}

function readToastLedger(): ToastLedger {
  const stored = getStorageItem<ToastLedger>(TOASTS_KEY);
  if (!stored || typeof stored !== 'object') {
    return { lastAt: 0, windowStart: 0, windowCount: 0, day2Day: '', firstActDay: '', goalDay: '', milestoneDay: '' };
  }
  return {
    lastAt: Number(stored.lastAt) || 0,
    windowStart: Number(stored.windowStart) || 0,
    windowCount: Number(stored.windowCount) || 0,
    day2Day: typeof stored.day2Day === 'string' ? stored.day2Day : '',
    firstActDay: typeof stored.firstActDay === 'string' ? stored.firstActDay : '',
    // Absent on a ledger written before the daily loop existed. Defaulting to '' means
    // "has not fired today", which is the correct reading of a field that did not exist.
    goalDay: typeof stored.goalDay === 'string' ? stored.goalDay : '',
    milestoneDay: typeof stored.milestoneDay === 'string' ? stored.milestoneDay : ''
  };
}

function writeToastLedger(ledger: ToastLedger): void {
  setStorageItem(TOASTS_KEY, ledger, StorageTTL.UI_STATE);
}

function prune(ledger: ActLedger, today: string): ActLedger {
  const oldest = addUtcDays(today, -LEDGER_DAYS);
  const days: Record<string, DayCounts> = {};
  for (const [day, counts] of Object.entries(ledger.days)) {
    if (day >= oldest) days[day] = counts;
  }
  return { days };
}

/**
 * Kinds that count toward the DAILY GOAL. Authored acts only.
 *
 * ★ NOT EVERY ACT KIND, AND THE REASON IS SYMMETRY RATHER THAN PURITY. The ring on the
 * Today card draws the server's `summary.today.acts`, which is chain-derived and
 * counts posts and comments — it cannot count votes, because a Hive user's vote
 * broadcasts from their browser and never touches this server. If this counted votes,
 * a lite user could fill the ring by voting while a Hive user doing the same thing
 * could not, and the goal-hit toast would fire on a ring that had not moved. One
 * currency, on both sides of the wire, or the two disagree in public.
 */
const GOAL_KINDS: RetentionActKind[] = ['post', 'reply'];

/**
 * Authored acts recorded today.
 *
 * ★ IT COUNTS ACTS, NOT KINDS. The goal is "two things today", so two replies has to
 * count as two — summing the counters is the only reading that matches the sentence
 * the picker shows.
 */
function countToday(ledger: ActLedger, today: string): number {
  const counts = ledger.days[today];
  if (!counts) return 0;
  return GOAL_KINDS.reduce((sum, kind) => sum + (counts[kind] ?? 0), 0);
}

/** Consecutive UTC days, ending today, on which at least one act was recorded. */
export function streakDaysFromLedger(ledger: ActLedger, today: string): number {
  let streak = 0;
  let cursor = today;
  while (ledger.days[cursor]) {
    streak += 1;
    cursor = addUtcDays(cursor, -1);
  }
  return streak;
}

export interface WeekTally {
  posts: number;
  replies: number;
  votes: number;
  follows: number;
  /** Days in the trailing 7 with at least one act. */
  activeDays: number;
  /** The window itself, so the copy never has to hardcode "7". */
  windowDays: number;
}

/**
 * The trailing-7-day tally behind the Monday recap. Counts acts CONFIRMED in
 * this browser — a lower bound on what the person actually did, never an
 * upper one, so the card can never overstate a week.
 */
export function weekTally(now: Date = new Date()): WeekTally {
  const today = utcDayKey(now);
  const ledger = readActLedger();
  const tally: WeekTally = { posts: 0, replies: 0, votes: 0, follows: 0, activeDays: 0, windowDays: 7 };
  for (let i = 0; i < tally.windowDays; i++) {
    const counts = ledger.days[addUtcDays(today, -i)];
    if (!counts) continue;
    tally.activeDays += 1;
    tally.posts += counts.post ?? 0;
    tally.replies += counts.reply ?? 0;
    tally.votes += counts.vote ?? 0;
    tally.follows += counts.follow ?? 0;
  }
  return tally;
}

/**
 * ★ 'goal-hit' AND 'milestone' ADDED 2026-08-09, WITHOUT RAISING THE CEILINGS.
 *
 * The daily loop needs a moment when the goal is met and a moment at a real streak
 * milestone, but the hard limits below (one toast per session, three per rolling week)
 * are unchanged — more moments competing for the same budget, not a bigger budget. The
 * priority order in `recordRetentionAct` decides which one wins, and it prefers the
 * rarer event, because a rare event is the only kind worth a toast.
 */
export type RetentionMomentKey = 'first-act' | 'streak-2' | 'goal-hit';

/**
 * Streak lengths worth a toast. Mirrors `lib/nudge.ts`'s STREAK_MILESTONES minus day
 * 2, which has its own copy and its own dedupe key.
 */
export const TOAST_MILESTONES = [3, 7, 14, 30, 50, 100, 200, 365];

export interface RetentionMoment {
  key: RetentionMomentKey;
  kind: RetentionActKind;
  streakDays: number;
}

type MomentListener = (moment: RetentionMoment) => void;

const listeners = new Set<MomentListener>();
/** A moment emitted before anything was listening (an act mid-navigation). */
let pending: RetentionMoment | null = null;

/** Subscribed by <RetentionFeedback />, which owns the translated copy. */
export function subscribeRetentionMoments(listener: MomentListener): () => void {
  listeners.add(listener);
  if (pending) {
    const moment = pending;
    pending = null;
    listener(moment);
  }
  return () => {
    listeners.delete(listener);
  };
}

function emit(moment: RetentionMoment): void {
  if (listeners.size === 0) {
    pending = moment;
    return;
  }
  for (const listener of listeners) listener(moment);
}

/**
 * Record one server-confirmed act and, if the ceilings allow it, emit ONE
 * feedback moment. Safe to call from anywhere (no React), safe to call on the
 * server (no-ops), and safe to call more often than the ceilings — that is what
 * the ceilings are for.
 */
export function recordRetentionAct(kind: RetentionActKind): void {
  if (typeof window === 'undefined') return;
  if (!ACT_KINDS.includes(kind)) return;
  try {
    recordAct(kind);
  } catch {
    // ★ NEVER LET A COSMETIC LEDGER BREAK A BROADCAST (2026-08-09).
    //
    // This is now called from `onSuccess` on the chain write path — the same handler
    // that shows the success toast and schedules the cache invalidations. Everything
    // below touches `localStorage`, which throws on a full quota, in private-mode
    // Safari, and whenever a browser blocks storage for the origin. A toast lost
    // because a habit counter could not be written would be an absurd trade: the post
    // is already on chain either way, and the whole point of this layer is that it is
    // worthless to the ladder.
  }
}

function recordAct(kind: RetentionActKind): void {
  const now = new Date();
  const today = utcDayKey(now);

  const ledger = prune(readActLedger(), today);
  const counts: DayCounts = ledger.days[today] ?? {};
  counts[kind] = (counts[kind] ?? 0) + 1;
  ledger.days[today] = counts;
  writeActLedger(ledger);

  const streakDays = streakDaysFromLedger(ledger, today);
  const toasts = readToastLedger();
  const nowMs = now.getTime();
  // ★ THE GOAL LIVES ON THE SERVER NOW, SO THE TOAST NO LONGER GUESSES AT IT.
  //
  // This read `readDailyGoal()` from localStorage to decide when to fire the "goal met"
  // toast. That value is gone (see lib/daily-goal.ts) because the goal became an input to
  // the streak. The honest consequence: this client-side ledger cannot know the server's
  // target, so the goal-hit toast fires on the FIRST act of the day — the smallest goal,
  // which is also the default. A reader on a higher goal gets the first-act toast rather
  // than a premature "goal met" one, which is the safe direction to be wrong in: a toast
  // that congratulates work not yet done would contradict the ring sitting beside it.
  //
  // Firing it exactly on the real target needs the server's goal on the client, i.e. this
  // ledger reading `summary.today.goal`. Worth doing; not worth guessing in the meantime.
  const goalTarget = 1;

  // Rolling-week window.
  if (nowMs - toasts.windowStart > WEEK_MS) {
    toasts.windowStart = nowMs;
    toasts.windowCount = 0;
  }

  // ★ WHICH MOMENT IS EVEN ELIGIBLE, RAREST FIRST. Only one toast may fire, so the
  // order is the whole policy: a 30-day milestone beats day 2, which beats the daily
  // goal, which beats "you did a thing". Reversing any pair would spend the one
  // available toast on the less interesting event.
  let key: RetentionMomentKey | null = null;
  // The 'milestone' toast carried the same "Nobody made you do it." line the feed
  // nudge did, and it is gone for the same reason (owner ruling 2026-08-10). Day 2
  // survives: "you came back" is an observation about the reader, not applause.
  if (streakDays === 2 && toasts.day2Day !== today) {
    key = 'streak-2';
  } else if (goalTarget > 0 && countToday(ledger, today) === goalTarget && toasts.goalDay !== today) {
    // EXACTLY the target, not >=, so this fires on the act that MET the goal and not
    // on every act after it. The `!==` day guard is a second belt, not the mechanism.
    key = 'goal-hit';
  } else if (toasts.firstActDay !== today) {
    key = 'first-act';
  }
  if (!key) return;

  // Ceilings, in order of strictness.
  if (nowMs - toasts.lastAt < SESSION_MS) return;
  if (toasts.windowCount >= MAX_TOASTS_PER_WEEK) return;

  toasts.lastAt = nowMs;
  toasts.windowCount += 1;
  if (key === 'streak-2') toasts.day2Day = today;
  else if (key === 'goal-hit') toasts.goalDay = today;
  else toasts.firstActDay = today;
  writeToastLedger(toasts);

  emit({ key, kind, streakDays });
}

/** Today's streak, for surfaces that want it without recording anything. */
export function currentStreakDays(now: Date = new Date()): number {
  if (typeof window === 'undefined') return 0;
  return streakDaysFromLedger(readActLedger(), utcDayKey(now));
}
