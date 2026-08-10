/**
 * ════ WHO IS READING, AND WHAT IS ACTUALLY TRUE FOR THIS ACCOUNT ════
 *
 * Pure copy SELECTION — which translation key a retention surface should print. No
 * React, no i18n, no DOM, so every rule below is unit-testable and pinned in
 * lib/__tests__/ladder.test.ts, including the assertion that every key this file can
 * name really exists in locales/en/common_blog.json. The dynamic `t(...)` keys these
 * produce are invisible to `lint:translations:usage`, which only reads string
 * literals — so the test is the gate, not the linter.
 *
 * ★ THE INSTRUCTIONS ARE GONE (2026-08-09, owner ruling).
 *
 * This module used to pick between nine static strings of ADVICE — "Post one thing.
 * Literally one.", "Reply to three people who aren't you.", "Get read by people who
 * don't already know you.", "Show up in more weeks." — routed to whichever arm was
 * binding. The routing was a genuine fix (it stopped telling @blocktrades to go find
 * strangers when presence was what held him), but it fixed the aim of the wrong
 * weapon. Handing the reader a chore list is the platform pushing its own job onto
 * them, and this product's whole argument is that the frontend does the work.
 *
 * What replaces all of it is one number. `rank.remainingToNext` exists — it is the
 * reason reputation had to go — so the surface prints "12 more people" and stops.
 * That is information; the paragraph was homework.
 *
 * TWO CASES STILL NEED A SENTENCE RATHER THAN A COUNT, and they are the two where a
 * count would be actively misleading:
 *
 *   1. DORMANT. @null (created 2016, 1,695 followers, zero posts ever) sits on the
 *      same rung as a genuine newcomer, and the rung is arithmetically right — the
 *      presence arm reads zero — but "nobody has found you yet" is false about an
 *      account nobody has heard from in nine years. `isDormant` separates
 *      tenure-rich silence from a genuinely new account, using the tenure arm the
 *      system had already computed.
 *   2. BLANK. Nothing published and nothing in the window: no arm is measuring
 *      anything yet, so a distance on the engagement arm would be a number about
 *      nothing.
 *
 * And VOICE, which was the third defect found on 2026-08-08 and still applies to
 * every line: "{{count}} people have engaged with your posts" was rendering on
 * strangers' profiles and to signed-out readers, on four of four sampled accounts.
 * It reads like a broken mail-merge because it is one — the sentence is addressed to
 * the account owner and shown to whoever is looking.
 */

export type RetentionVoice = 'own' | 'other';

/**
 * The suffix that makes a key third-person. i18next appends its plural suffix
 * AFTER whatever key it is handed, so `voiced('retention.facts.givers','other')`
 * resolves through `retention.facts.givers_their_one` / `_their_other` — which is
 * why the third-person plural forms carry the suffix in that order.
 */
const THIRD_PERSON = '_their';

/**
 * Second person for the account's owner, third person for everybody else.
 *
 * Only ever call this with a key that HAS a `_their` sibling — a missing sibling
 * renders the raw key on screen, which is worse than the bug it fixes. The test
 * asserts both members of every pair exist.
 */
export function voiced(key: string, voice: RetentionVoice): string {
  return voice === 'own' ? key : `${key}${THIRD_PERSON}`;
}

/**
 * Halfway up the tenure arm, whichever ladder is doing the measuring
 * (dormancy reads `tenureYear` on both paths now; it used to read `gate.tenure`, which
 * 240 on Lumen). At or above this an account is not new by any reading, so
 * "nobody has found you yet" is a false statement about it rather than a gentle
 * one. Deliberately NOT the saturation point: @null is nine years old, but a
 * one-year-old account silent for the whole presence window is just as obviously
 * not a beginner.
 */
/**
 * How many years on Hive make silence "dormant" rather than "new".
 *
 * ★ IT READS THE TENURE YEAR NOW, NOT AN ARM (2026-08-09). It used to read `gate.tenure`, a
 * 0..1 fraction of the ladder's tenure arm — and that arm is deleted, because Hive account age
 * no longer buys rank ("no one gets rank 7 off the bat"). Dormancy is a COPY decision, not a
 * rank input, so it can go on using Hive age without reintroducing it to the ladder: an account
 * that joined in 2016 and has done nothing recently should not be told "nobody has found you
 * yet". `tenureYear` is on the wire as a stat and is exact.
 */
export const DORMANT_MIN_YEARS = 2;

export interface DormancyInput {
  /** `tenureYear` from the summary — the Hive account's creation year. 0 when unknown. */
  tenureYear: number;
  /** The current UTC year, injected so this stays pure. */
  nowYear: number;
  /** `activeWeeks` — presence inside the printed window. */
  activeWeeks: number;
  /**
   * `provenance.coverage.commentsFeedUnavailable`. When the comments feed failed
   * outright, absence was not MEASURED — some of the account's acts were never
   * read — so we decline to call it dormant rather than publish a guess as a fact.
   */
  commentsFeedUnavailable?: boolean;
}

/**
 * Hive tenure without presence. The only combination the copy needs to split off: an OLD account
 * with nothing in the window is dormant, a NEW one with nothing is new, and telling a 2016
 * account "nobody has found you yet" is the kind of mail-merge that reads as broken.
 *
 * Safe against a truncated walk. Both feeds are read newest-first, so an act inside the window is
 * read before anything older; `activeWeeks === 0` after a capped walk still means nothing
 * happened in the window. The one hole is a feed that failed entirely, and that is excluded.
 */
export function isDormant(input: DormancyInput): boolean {
  if (input.commentsFeedUnavailable) return false;
  if (!input.tenureYear || !input.nowYear) return false;
  return input.nowYear - input.tenureYear >= DORMANT_MIN_YEARS && input.activeWeeks <= 0;
}

/**
 * Which line the "where this account stands" slot should print.
 *
 *   'dormant'  — old and silent. A distance would imply they are on their way up.
 *   'blank'    — nothing published at all. No arm is measuring anything yet.
 *   'progress' — the normal case: print the count and nothing else.
 *   'top'      — rung 9. There is no distance, because there is nowhere above.
 */
export type StandingLineKind = 'dormant' | 'blank' | 'progress' | 'top';

export interface StandingLineInput {
  dormant: boolean;
  /**
   * Nothing published AND nothing in the presence window — a genuinely blank
   * account. Deliberately both: an account that only ever comments has no posts
   * but real presence, and its binding arm is measuring something.
   */
  blank: boolean;
  /** `rank.remainingToNext` — null only at the top of the ladder. */
  remainingToNext: number | null;
}

/** ORDER MATTERS: each step is a fact that outranks the next. */
export function standingLineKind(input: StandingLineInput): StandingLineKind {
  if (input.dormant) return 'dormant';
  if (input.blank) return 'blank';
  if (input.remainingToNext === null) return 'top';
  return 'progress';
}
