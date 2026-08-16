/**
 * MERITUM TICKER — the tape copy, and the two numbers derived from it.
 *
 * Source: `handoff_meritum_onboarding/ticker/ticker.html` +
 * `MERITUM-VISUAL-BUILD-CHECKLIST-2026-08-15.md` ("The tape (the name crawl)").
 *
 * ★ THIS FILE IS THE ONLY PLACE THE COPY EXISTS. The tape renders the list
 * TWICE (that is how the seamless loop works — see meritum-ticker.module.css),
 * and both copies map over this same array. The handoff ships the two copies as
 * duplicated markup with the comment "byte-for-byte identical to copy 1", which
 * is a standing invitation for the second copy to drift from the first the
 * first time somebody edits a figure. Here it cannot: there is one array.
 *
 * ★ THE 13 ITEMS AND THEIR ORDER ARE FIXED BY EXPLICIT OWNER INSTRUCTION.
 * Do not add, remove, reorder or reword them without that instruction. If the
 * count ever does change, `meritumTickerDurationSeconds()` below already
 * rescales the animation so the tape keeps the same visual speed — but read the
 * note on that function before trusting it.
 *
 * ★ EXCEPTION, 2026-08-16 (H9 fix): three items carried second-level timings
 * ("4 seconds ago", "47 seconds") that paired with the `● LIVE` badge above
 * the tape to read as a real-time feed of actual events, when this is a
 * fixed, fictional example loop and the real Meritum data source returns
 * nothing (see `meritum-intro.tsx`'s `liveLabel` and the "Meritum isn't
 * available on this build yet" notice one section down on the same screen —
 * a stopwatch-precise timestamp directly contradicting a build-not-live
 * notice is the exact kind of thing this file's own copy has to stay honest
 * about). Reworded to describe launch SPEED, which is the real, evergreen
 * claim these three items make, rather than a specific elapsed time, which
 * is not. Dollar amounts and holder counts are untouched — they read as
 * example outcomes, not as a live clock.
 *
 * ★ NOT TRANSLATED, DELIBERATELY. `CLAUDE.md` bans inline user-facing strings,
 * and this file breaks that rule on purpose: the owner specified these 13
 * strings verbatim, and routing them through `t()` would mean 52 locale keys
 * whose English values must never be changed — a translation surface for copy
 * that is explicitly not allowed to vary. The one string in the component that
 * IS chrome rather than owner-fixed copy (the "Live" label) is a prop, so the
 * calling page can pass a translated value.
 */

export interface MeritumTickerItem {
  /** The handle, rendered ink / 700. Includes the leading `@`. */
  readonly handle: string;
  /**
   * The sentence that runs BETWEEN the handle and the figure, muted / 500.
   *
   * ★ THE LEADING AND TRAILING SPACES IN THESE STRINGS ARE LOAD-BEARING. They
   * are what separates `@maximus` from `launched` and `token ·` from `4
   * seconds ago`. `.item { white-space: pre }` in the stylesheet is what keeps
   * them; without it every one of these renders as `@maximus : 12`-style
   * mush. Do not "tidy" them away.
   */
  readonly sentence: string;
  /** The figure, brand red / 700 / tabular numerals. */
  readonly figure: string;
  /**
   * Text that runs AFTER the figure. Empty for most items.
   *
   * ★ THIS FIELD IS WHY THE FIGURE IS NOT ALWAYS LAST. The figure sits where it
   * was written in the sentence. Normalising figures to the end of the line
   * turns item 4 into "@pontiuspilate has on day one 12 holders" and item 7
   * into "@silliussoddus launched in flat 5 seconds". Both ungrammatical.
   */
  readonly trailing: string;
}

/**
 * Verbatim, in this order. Fields are: handle / sentence-before / figure /
 * trailing-after. The separator is `·` (U+00B7), never an em dash.
 */
export const MERITUM_TICKER_ITEMS: readonly MeritumTickerItem[] = [
  { handle: '@maximus', sentence: ' launched her token in ', figure: 'seconds', trailing: '' },
  { handle: '@biggusdickus', sentence: ' answered 3 asks today · ', figure: '$120', trailing: '' },
  { handle: '@cicero', sentence: ' got paid for his first ask · ', figure: '$40', trailing: '' },
  { handle: '@pontiuspilate', sentence: ' has ', figure: '12 holders', trailing: ' on day one' },
  { handle: '@seneca', sentence: ' got booked for a custom track · ', figure: '$75', trailing: '' },
  { handle: '@octavia', sentence: ' priced her first offer · ', figure: '$25', trailing: '' },
  { handle: '@silliussoddus', sentence: ' launched in ', figure: 'seconds', trailing: ' flat' },
  { handle: '@agrippa', sentence: ' found his first holder in ', figure: 'no time', trailing: '' },
  { handle: '@cassiusclay', sentence: ' got tipped · ', figure: '$12', trailing: '' },
  { handle: '@drusilla', sentence: ' just crossed ', figure: '100 holders', trailing: '' },
  { handle: '@naughtiusmaximus', sentence: ' got booked for a session · ', figure: '$90', trailing: '' },
  { handle: '@flavia', sentence: ' got asked for a logo · ', figure: '$60', trailing: '' },
  { handle: '@brutus', sentence: ' answered every ask this week · ', figure: '$210', trailing: '' }
] as const;

/**
 * How many times the item list is rendered inside the track.
 *
 * ★ TYPED AS THE LITERAL `2`, NOT `number`, ON PURPOSE. This value is not free
 * to change: the keyframe that moves the track lives in
 * `packages/tailwindcss/globals.css` (`@keyframes mt-tape`), which is owned by
 * the foundation agent and hardcodes `translate3d(-50%, 0, 0)`. 50% is one copy
 * of two and nothing else. Widening the type would let somebody set 3 here and
 * get a tape that jumps a third of the way through every loop, with no error
 * anywhere. See `MERITUM_TICKER_SHIFT_PERCENT`.
 *
 * ★ CONSTRAINT: `MERITUM_TICKER_COPIES × (width of one copy)` must exceed the
 * widest viewport the tape can appear in, or the wrap becomes visible as a gap
 * — at the moment the track has travelled one full copy, copy 2 has to still
 * be covering every pixel copy 1 used to. Two copies of 13 items at 18px is
 * roughly 11,900px of track (measured), so this holds comfortably. It would NOT
 * hold for a three-item tape, which is the case to think about before
 * shortening the list.
 */
export const MERITUM_TICKER_COPIES: 2 = 2;

/**
 * The percentage the track translates over one loop. **Derived, not typed in.**
 *
 * DERIVATION. `transform: translateX(%)` resolves against the element's own
 * border box, and the track is `width: max-content`, so its box is exactly
 * `COPIES` copies wide. Moving the track by exactly one copy is therefore
 *
 *     one copy / whole track  =  1 / COPIES  =  100 / COPIES  percent
 *
 * At `COPIES = 2` that is **50%**. Because every copy is identical, the track
 * at `-100/COPIES %` is pixel-identical to the track at `0`, so frame 100% and
 * frame 0 are the same image and the wrap is invisible. Verified in a browser
 * against the real stylesheet: track 11883.40625px, one copy 5941.703125px,
 * 50% of the track = 5941.703125px — exact to the last binary digit.
 *
 * ★ WHY THIS IS EXPORTED WHEN NOTHING CONSUMES IT AS A STYLE. The component
 * does NOT feed this to CSS, because the shared `@keyframes mt-tape` already
 * carries `-50%` and the coordination rule for this build is that the motion
 * layer has exactly one home. This constant is the DERIVATION kept next to the
 * copy it depends on, so the coupling is written down instead of remembered:
 * if `MERITUM_TICKER_COPIES` ever changes, this stops matching
 * `SHARED_MT_TAPE_SHIFT_PERCENT` below and the shared keyframe has to change
 * with it. Deleting this constant would delete the only record of that.
 */
export const MERITUM_TICKER_SHIFT_PERCENT = 100 / MERITUM_TICKER_COPIES;

/**
 * What `@keyframes mt-tape` in `packages/tailwindcss/globals.css` actually
 * implements. It is the number `MERITUM_TICKER_SHIFT_PERCENT` must equal.
 *
 * Kept as its own named constant rather than a comment so that a reader who
 * greps for the coupling finds both halves of it in one file.
 */
export const SHARED_MT_TAPE_SHIFT_PERCENT = 50;

/**
 * ★ COMPILE-TIME TRIPWIRE ON THE ONE COUPLING THIS FILE CANNOT ENFORCE.
 *
 * `-50%` is one copy only when there are exactly two copies. That percentage
 * lives in a file this feature does not own, so raising the copy count here
 * would otherwise produce a tape that jumps mid-loop with nothing to catch it —
 * no type error, no lint error, no test, just a visible stutter every 58
 * seconds that reads as a rendering glitch.
 *
 * This line makes that change fail to compile: `MERITUM_TICKER_COPIES` is typed
 * as the literal `2`, so widening it produces
 * "Type '3' is not assignable to type '2'" pointing straight at this comment.
 * If you are here because of that error, the fix is to change
 * `@keyframes mt-tape` in `packages/tailwindcss/globals.css` to
 * `-${MERITUM_TICKER_SHIFT_PERCENT}%` in the same commit — and to tell whoever
 * owns that file, because the launch-flow screens read the same keyframe.
 */
type CopyCountTheSharedKeyframeSupports = 2;
const _sharedKeyframeCopyCountGuard: CopyCountTheSharedKeyframeSupports = MERITUM_TICKER_COPIES;

/**
 * The calibration anchor, straight from the handoff: **58 seconds per copy at
 * 13 items**. Speed is duration, not distance — the tape is one copy long per
 * cycle, so a longer list at the same duration would scroll visibly faster.
 *
 * ★ A DISCREPANCY IN THE HANDOFF, RESOLVED HERE. Both the checklist and
 * `ticker.html` gloss the anchor as "~4.2s per item", but 58 / 13 = 4.4615…,
 * and 13 × 4.2 = 54.6s, not 58s. The anchor pair (58s, 13 items) is the value
 * that was actually looked at and signed off; "4.2" is a rounded aside. So the
 * per-item rate is derived FROM the anchor rather than typed in from the
 * aside, which also means the canonical 13-item case reproduces 58.00s exactly
 * instead of drifting 6% faster.
 */
const MERITUM_TICKER_ANCHOR_SECONDS = 58;
const MERITUM_TICKER_ANCHOR_ITEMS = 13;

/**
 * Seconds one copy of the tape takes to travel its own width, for a given item
 * count, holding the anchor's visual speed.
 *
 *     duration = ANCHOR_SECONDS × count / ANCHOR_ITEMS
 *              = 58 × count / 13
 *
 * Check the two cases a reviewer cares about:
 *   count = 13 → 58 × 13 / 13 = **58.00s** (the anchor, reproduced exactly)
 *   count = 15 → 58 × 15 / 13 = **66.92s**
 *
 * WHY LINEAR IN THE COUNT. Visual speed is pixels per second. One cycle covers
 * one copy, so `speed = copyWidth / duration`, and `copyWidth` is proportional
 * to the number of items (they are drawn from the same copy register at the
 * same size, so average item width is roughly constant). Holding `speed` fixed
 * while `copyWidth` scales with `count` means `duration` must scale with
 * `count` too. This is an approximation in one respect and it is worth naming:
 * items are NOT all the same width, so swapping 13 short items for 13 long
 * ones changes the real pixel speed without changing the duration. Measuring
 * the track and dividing by a px/s constant would be exact, but it costs a
 * layout read plus a ResizeObserver, and the handoff's contract is explicitly
 * count-based. If the copy is ever rewritten wholesale, re-eyeball the speed.
 *
 * Rounded to 2dp so the value that reaches CSS is `58s`, not
 * `58.000000000000004s`.
 *
 * ★ HOW THIS REACHES CSS, AND WHY IT IS NOT REDUNDANT. The shared `.mt-tape`
 * class already says `animation: mt-tape 58s linear infinite`, so at 13 items
 * this computes the value the stylesheet would have used anyway. It is still
 * applied, as an inline `animation-duration` longhand, for two reasons. First,
 * a longhand in the style attribute beats the class's shorthand, so the tape's
 * speed tracks the item count instead of only appearing to. Second — and this
 * is the part that matters — `58s` in the shared file is correct for THIS list
 * and no other; anyone adding a 14th item would otherwise silently speed the
 * tape up by 8% and there would be nothing to notice. Reduced motion still
 * wins over it: the shared rule is `animation: none !important`, and an
 * `!important` shorthand beats a non-important inline longhand.
 */
export function meritumTickerDurationSeconds(itemCount: number): number {
  const raw = (MERITUM_TICKER_ANCHOR_SECONDS * itemCount) / MERITUM_TICKER_ANCHOR_ITEMS;
  return Math.round(raw * 100) / 100;
}

/** The duration for the canonical 13-item tape. Equals 58. */
export const MERITUM_TICKER_DURATION_SECONDS = meritumTickerDurationSeconds(MERITUM_TICKER_ITEMS.length);
