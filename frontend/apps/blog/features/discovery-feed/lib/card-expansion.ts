/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHEN A POST CARD IS ALLOWED TO EXPAND.
 *
 * ★★★ REWRITTEN 2026-08-25. THE DRAWER NO LONGER OPENS ON HOVER.
 *
 * Owner ruling: "only on clicking empty card it should show drop down ... the
 * hover over doesnt work well its annoying." The drawer is now opened by a
 * CLICK on the card's empty space and by keyboard focus, and by nothing else.
 *
 * That deleted most of this file, and the deletions are the point rather than a
 * casualty. Everything removed existed ONLY to stop hover from misfiring:
 *
 *   • the 350ms dwell (`DWELL_MS`) — a click states intent on its own; there is
 *     no travel to disambiguate and nothing to wait out
 *   • the capture-phase scroll listener, the 150ms tail and the settle
 *     subscription — all of it compensated for the fact that `pointerenter`
 *     fires during a scroll and never fires again. A click cannot be triggered
 *     by the feed moving underneath a stationary pointer, so none of it applies
 *   • closing every open card on the first scroll event — actively WRONG now.
 *     A reader who clicked to open a comment then scrolls to read it must not
 *     have it shut underneath them; the old rule only made sense when the card
 *     had opened itself without being asked
 *   • the 120px bottom guard — it refused to open a card near the viewport
 *     bottom because an unrequested expansion pushing unseen content is rude.
 *     A card the reader deliberately clicked is not unrequested
 *
 * ★★★ AND NOW THE LAST OF IT IS GONE TOO — "ONE AT A TIME" WAS THE JUMP
 * (owner, 2026-09-06: "when I scroll down and click another card, sometimes it
 * doesn't know where to point my focus to on screen, it just jumps to a random
 * spot in the feed ... might have something to do with the prior card getting
 * closed when another card is opened").
 *
 * The owner's guess was exactly right, and it measures cleanly. `claimOpen`
 * closed the previously-open card. By the time the reader clicks a second card
 * they have usually scrolled the first one ABOVE the viewport, so that close
 * deletes its drawer's height from the document ABOVE the reader — and the
 * browser does not give it back. Nothing scrolls; the page simply gets shorter
 * over their head and everything below slides up under a stationary scrollY.
 *
 * Measured on production, signed in, 1440x900, 6 runs (scratchpad
 * `measure-jump.cjs`): with a 202px drawer open above the fold, the clicked
 * card's viewport top went 311 -> 109 five times out of five, `window.scrollY`
 * pinned at 2700 the whole time. The sixth run is the negative control — the
 * card above happened to have a 0px drawer (no top comment), nothing collapsed,
 * and the jump was 0px. The jump size IS the closing drawer's height, which
 * varies with that thread's length: hence "a random spot", and hence
 * "sometimes".
 *
 * Scroll anchoring is supposed to absorb exactly this and demonstrably did not
 * (scrollY never moved). Rather than fight the browser for the right to remove
 * content from above a reader, do not remove it: a card the reader opened stays
 * open until they close it, or until they leave the page. Nothing above the
 * viewport changes height, so there is nothing to compensate for.
 *
 * A/B on a dev build of this exact code, 8 runs each, same harness, a 938px
 * drawer open above the fold. BEFORE: the clicked card's viewport top went
 * 613 -> -325 (and 431 -> -507, 163 -> -775, 351 -> -587), -938px every single
 * run, 8/8, `document.scrollHeight` down by the same amount. AFTER: 0px, 8/8,
 * and two drawers open at once where there had been one.
 *
 * That leaves this module with one export: the input-modality flag below.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WAS THE LAST INPUT A KEYBOARD?
 *
 * ★★★ WHY `:focus-visible` IS NOT ENOUGH, measured 2026-08-25.
 *
 * The drawer opens on focus so a keyboard reader is not stranded in a
 * `height: 0` box. The card therefore has to answer "did this focus come from a
 * keyboard?", and `:focus-visible` looks like exactly that answer. It is not.
 *
 * When a Radix overlay closes — the overflow menu, the downvote popover — it
 * RESTORES FOCUS TO ITS TRIGGER, and that trigger is inside the card.
 * Programmatic restoration qualifies as focus-visible, so the card saw
 * "keyboard focus on one of my children" and opened. Observed directly: click
 * the ··· menu, click "Downvote", and the drawer opens behind the popover, with
 * `matches(':focus-visible')` returning true throughout.
 *
 * Input MODALITY is the thing actually being asked about, and it cannot be read
 * off an element — only off the event stream. `keydown` means the reader is on
 * the keyboard; `pointerdown` means they are not. A focus that follows a
 * pointerdown is the residue of a click, whoever moved it and however.
 *
 * One pair of listeners for the whole feed, attached once at module scope, for
 * the same reason the scroll flag used to be module-level: twenty cards each
 * tracking this would be twenty copies that disagree at the edges.
 * ═══════════════════════════════════════════════════════════════════════════
 */
let keyboardModality = false;

/**
 * ★★★ ONLY *NAVIGATION* KEYS ARM IT — NOT EVERY KEYDOWN (2026-08-25, found by
 * adversarial review and reproduced 3/3).
 *
 * The first version set this on ANY keydown, and that reopened the drawer every
 * time a reader dismissed a menu:
 *
 *   click "···" with the mouse   -> pointerdown, modality = pointer, menu opens,
 *                                   drawer correctly stays shut
 *   press Escape                 -> keydown, modality flipped to KEYBOARD
 *   Radix restores focus to the trigger, which is INSIDE the card
 *   `onCardFocus` sees in-card focus + "keyboard" -> opens the drawer
 *
 * The reader asked to close a menu and got a drawer. Escape, Enter and Space are
 * not navigation — they act on the thing already focused. Only Tab (and the
 * arrow keys, which move focus inside a menu or a radio group) mean "I am moving
 * focus around with the keyboard", which is the only thing `onCardFocus` is
 * entitled to treat as a request to open.
 *
 * Note this is deliberately NOT symmetric: a pointerdown always disarms, because
 * any pointer press means the reader has picked up the mouse. Arming is the
 * narrow case; disarming is the safe one.
 */
const NAVIGATION_KEYS = new Set([
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End'
]);

if (typeof document !== 'undefined') {
  // Capture, so a component that stops propagation cannot blind the flag.
  document.addEventListener(
    'keydown',
    (e) => {
      if (NAVIGATION_KEYS.has((e as KeyboardEvent).key)) keyboardModality = true;
    },
    true
  );
  document.addEventListener(
    'pointerdown',
    () => {
      keyboardModality = false;
    },
    true
  );
}

/** True when the reader's most recent input was keyboard NAVIGATION, not a pointer. */
export function lastInputWasKeyboard(): boolean {
  return keyboardModality;
}
