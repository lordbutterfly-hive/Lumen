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

/**
 * ════ HOW MUCH SOMEBODY HAS ACTUALLY WRITTEN ════
 *
 * Owner, 2026-08-18: "maybe how many lines of text they wrote. that coul dbe good. you
 * have written in 1 year the equivalent of a 100 page book, stuff like that thats
 * interesting."
 *
 * WORDS RATHER THAN LINES, and the choice is not cosmetic. A "line" in a markdown body
 * is a hard wrap, so it counts how the author's editor was configured rather than
 * anything about the writing: the same paragraph is one line pasted from a word
 * processor and nine typed in a narrow window. Words survive the round trip, and words
 * are the only unit a page count can honestly be derived from.
 *
 * ★ WHAT IS DELIBERATELY NOT COUNTED. Fenced and inline code, image markup, raw URLs and
 * HTML tags all inflate a word count without anybody having written a word — a post that
 * embeds a 200-line config file is not a 900-word essay. Link TEXT is kept and the link
 * TARGET is dropped, because the text is the part a person wrote. Markdown punctuation
 * (`#`, `>`, `*`, table pipes) is stripped before the split so a heading does not pay for
 * its own hashes.
 *
 * ★ ONE HONEST LIMITATION, STATED: this splits on whitespace, so it is a word count for
 * space-separated scripts and a rough character-cluster count for languages that do not
 * space their words (Chinese, Japanese, Thai). Every word counter in existence has this
 * property; naming it here is cheaper than a reader discovering it.
 */
export function countWords(body: string | undefined): number {
  if (!body) return 0;
  const text = body
    .replace(/```[\s\S]*?```/g, ' ') // fenced code blocks
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`\n]*`/g, ' ') // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images: no words at all
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links: keep the label, drop the target
    .replace(/<[^>]{1,200}>/g, ' ') // html tags (bounded, so a stray `<` cannot eat the post)
    .replace(/\bhttps?:\/\/\S+/gi, ' ') // bare urls
    .replace(/[#>*_~|`]+/g, ' '); // markdown furniture
  // A token counts when it contains at least one character that is not punctuation,
  // whitespace or a symbol — so `---`, `|` and a lone `.` are not words.
  return text.split(/\s+/).filter((tok) => /[^\s\p{P}\p{S}]/u.test(tok)).length;
}

/**
 * Words on a printed page, for the book comparison.
 *
 * 250 is the manuscript-page convention (double-spaced, 12pt) and the figure most
 * "how long is a novel" guidance is quoted in. A mass-market paperback sets closer to
 * 300, so this errs toward the LARGER page count — which is why the copy that uses it
 * says the divisor out loud rather than presenting the pages as a fact about a specific
 * edition of a specific book. A comparison the reader cannot check is a boast.
 */
export const WORDS_PER_PAGE = 250;

/** Printed pages, rounded down. Zero until there is genuinely a page of it. */
export function pagesFromWords(words: number): number {
  if (!Number.isFinite(words) || words <= 0) return 0;
  return Math.floor(words / WORDS_PER_PAGE);
}

/**
 * ════ WHICH TIME WINDOW THE WORD COUNT IS SHOWN OVER ════
 *
 * ★ IT ROTATES (owner, 2026-08-18: "this needs to change with time look3d at. one day
 * 7 days, one time all time, one time, last 10 days").
 *
 * A single frozen lifetime figure is the flaw a UX tester named about this whole card:
 * "every number is a single frozen figure, nothing to compare against". A lifetime word
 * count is the worst offender — it can only go up, slowly, forever. Rotating the window
 * turns one dead number into five live ones for the price of four extra SQL aggregates
 * over a scan the route already pays for.
 *
 * ★ DETERMINISTIC, NOT RANDOM, AND SEEDED BY THE READER AS WELL AS THE DAY. Same reader,
 * same day, same window — so the card does not change under somebody mid-read, and a
 * cached response body renders identically to a fresh one (the choice is made at render
 * time from data that is on the wire, never baked into the cached body). Mixing the
 * username in means two people looking on the same day do not see the same window, which
 * is the difference between "this app has a fact about me" and "this app is on a cycle".
 * `Math.random()` would fail both properties.
 */
export type WordWindow = 'day' | 'week' | 'month' | 'year' | 'all';

/** Rotation order. Shortest first, so the fallback below widens rather than narrows. */
export const WORD_WINDOW_ORDER: WordWindow[] = ['day', 'week', 'month', 'year', 'all'];

/** How many days back each window reaches. `all` has no start. */
export const WORD_WINDOW_DAYS: Record<WordWindow, number | null> = {
  day: 1,
  week: 7,
  month: 30,
  year: 365,
  all: null
};

/**
 * Below this, a window is not worth a line.
 *
 * ★ NOT ZERO, AND THE DIFFERENCE MATTERS. "You have written 0 words today" is true,
 * useless and slightly rude; so is "You have written 12 words today". The line exists to
 * say something a reader would repeat, and the smallest number worth repeating is about a
 * paragraph. Under this the picker widens to the next window rather than printing a
 * deflation — the same ABSENT-NEVER-ZERO rule the rest of this card follows, applied to a
 * quantity that has five candidate scopes instead of one.
 */
export const MIN_WORDS_TO_MENTION = 60;

export interface WordWindowChoice {
  window: WordWindow;
  words: number;
  /** The window reaches further back than the day set is complete from. */
  isFloor: boolean;
}

/** Stable, order-independent hash. Only ever used to rotate a label. */
function seedOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 100_000;
  return h;
}

/**
 * Pick the window to print, or `null` when none of them clears the floor.
 *
 * @param words      the five sums from the store
 * @param todayUTC   'YYYY-MM-DD', the rotation's clock
 * @param seed       the account name, so two readers differ on the same day
 * @param completeFrom the oldest day the day set is COMPLETE from (`''` = no boundary)
 * @param historyComplete the walk has reached account creation, so `all` is a total
 */
export function pickWordWindow(
  // `monthPrior` rides along on the same object but is NOT a selectable window — it exists
  // only to give `month` a direction (`wordsTrend`). Widening the parameter rather than
  // adding it to `WordWindow` keeps it unpickable by construction.
  words: (Partial<Record<WordWindow, number>> & { monthPrior?: number }) | undefined,
  todayUTC: string,
  seed: string,
  completeFrom = '',
  historyComplete = false
): WordWindowChoice | null {
  if (!words) return null;
  const dayNumber = Math.floor(Date.parse(`${todayUTC}T00:00:00Z`) / 86_400_000);
  if (!Number.isFinite(dayNumber)) return null;
  const start = (((dayNumber + seedOf(seed)) % WORD_WINDOW_ORDER.length) + WORD_WINDOW_ORDER.length) %
    WORD_WINDOW_ORDER.length;

  for (let i = 0; i < WORD_WINDOW_ORDER.length; i++) {
    const window = WORD_WINDOW_ORDER[(start + i) % WORD_WINDOW_ORDER.length];
    const value = words[window];
    if (typeof value !== 'number' || value < MIN_WORDS_TO_MENTION) continue;
    return { window, words: value, isFloor: windowIsFloor(window, todayUTC, completeFrom, historyComplete) };
  }
  return null;
}

/**
 * Is this window's figure a floor rather than a total?
 *
 * ★ SHORT WINDOWS ARE THE TRUSTWORTHY ONES HERE. The feed walk runs newest-first under a
 * clock, so it always reads the recent end and truncates the far one — the opposite of the
 * usual assumption that a longer span is safer. `all` needs the walk to have reached
 * account creation; every other window needs only that the day set is complete back to
 * where that window starts.
 */
export function windowIsFloor(
  window: WordWindow,
  todayUTC: string,
  completeFrom: string,
  historyComplete: boolean
): boolean {
  if (window === 'all') return !historyComplete;
  if (!completeFrom) return false; // nothing bounded the walk
  const days = WORD_WINDOW_DAYS[window];
  if (days === null) return !historyComplete;
  const startMs = Date.parse(`${todayUTC}T00:00:00Z`) - (days - 1) * 86_400_000;
  if (!Number.isFinite(startMs)) return true;
  return completeFrom > new Date(startMs).toISOString().slice(0, 10);
}

/**
 * The month-on-month direction of somebody's writing, or `null` when none may be claimed.
 *
 * ★ A MISSING OR ZERO PRIOR MONTH IS NOT A TREND — the same guard, for the same reason, as
 * `reachTrend`: the store only holds what has been walked, so "0 last month" means EITHER
 * they wrote nothing OR we had not read that far back yet, and those license opposite
 * claims. A flat month is silent too; "the same as last month" is copy to report an
 * absence of news.
 */
export const MIN_WORD_TREND_PCT = 10;

export function wordsTrend(month: number, monthPrior: number): { up: boolean; pct: number } | null {
  if (!(monthPrior > 0) || !(month > 0)) return null;
  const pct = Math.round(((month - monthPrior) / monthPrior) * 100);
  if (Math.abs(pct) < MIN_WORD_TREND_PCT) return null;
  return { up: pct > 0, pct: Math.abs(pct) };
}
