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
 * What survives is the one rule that is still a statement about the FEED rather
 * than about one card, and is still wanted: only one card open at a time.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Every card that is currently OPEN, by its own close function. A Set rather
 * than a single "current" reference because "close any other" has to be able to
 * run even if two cards somehow opened in the same frame — closing all but the
 * claimant is correct in both cases, where clobbering a single slot is not.
 */
const open = new Set<() => void>();

/**
 * "One at a time. Opening a card closes any other." The caller passes its own
 * close function and MUST call `releaseOpen` when it closes by any route.
 */
export function claimOpen(close: () => void): void {
  for (const other of [...open]) if (other !== close) other();
  open.add(close);
}

export function releaseOpen(close: () => void): void {
  open.delete(close);
}

/** Test seam. Resets every module-level bit of state. */
export function __resetCardExpansion(): void {
  open.clear();
}

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
