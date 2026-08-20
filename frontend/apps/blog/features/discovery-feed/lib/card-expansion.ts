/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHEN A POST CARD IS ALLOWED TO EXPAND.
 * Built to the 2026-08-20 card-expansion SPEC.md §8 ("Suppression").
 *
 * Three of the four suppression rules are CROSS-CARD — they are statements about
 * the feed, not about one card — so they cannot live in the card component:
 *
 *   • "One at a time. Opening a card closes any other."
 *   • "A capture-phase scroll listener sets a flag ... any open card closes on
 *     the first scroll event."
 *   • the 150ms tail after the last scroll event, which is one timer for the
 *     whole feed rather than one per card.
 *
 * The fourth ("bottom guard") is per-card geometry and lives with the card, but
 * `withinBottomGuard` is here so the 120px is written once.
 *
 * ★★ WHY A CAPTURE-PHASE LISTENER AND NOT A BUBBLING ONE. `scroll` does not
 * bubble from an arbitrary scrolling element — only from the document. A feed
 * inside its own overflow container would therefore never reach a bubbling
 * document listener, and the suppression would silently do nothing on exactly
 * the layouts that scroll. Capture on `document` sees every scroll event in the
 * tree regardless of which element produced it.
 *
 * ★ WHY THE FLAG IS NOT "isScrolling" IN A REF PER CARD. Twenty cards each
 * running their own listener and their own 150ms timer is twenty timers doing
 * identical work, and they would disagree at the edges. One module-level flag is
 * both cheaper and the only version that can be correct.
 *
 * ★ THE LISTENER IS LAZY AND REFERENCE-COUNTED. It attaches when the first card
 * subscribes and detaches when the last unsubscribes, so a page with no feed on
 * it carries no listener at all.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** §8: "If its bottom edge is within 120px of the viewport bottom." */
export const BOTTOM_GUARD_PX = 120;

/** §8: "clears it 150ms after the last event." */
const SCROLL_TAIL_MS = 150;

/** §1: "350ms, hover anywhere on the card." */
export const DWELL_MS = 350;

let scrolling = false;
let scrollTail: ReturnType<typeof setTimeout> | null = null;

/**
 * Every card that is currently OPEN, by its own close function. A Set rather
 * than a single "current" reference because "close any other" has to be able to
 * run even if two cards somehow opened in the same frame — closing all but the
 * claimant is correct in both cases, where clobbering a single slot is not.
 */
const open = new Set<() => void>();

/**
 * Cards that want to know when scrolling has SETTLED.
 *
 * ★★★ WHY THIS EXISTS, because it is not in the spec and it fixes a real defect.
 * §8 says "Pointer entry returns early while [the scroll flag] is set". Taken
 * literally and no further, that strands the single most common way anyone reads
 * a feed: scroll down, stop, leave the pointer where it landed. `pointerenter`
 * fired DURING the scroll, so it returned early — and it never fires again,
 * because the pointer never moves. The card then cannot open at all until the
 * reader moves out and back in, which they have no reason to do.
 *
 * Measured 2026-08-20: `qa-drawer.mjs` and `qa-animations.mjs` both reported
 * "drawer did not open on hover" against a drawer whose keyboard path opened
 * fine, and this was why.
 *
 * So the flag clearing is an EVENT, not just a state change: when scrolling
 * settles, every card still under the pointer re-arms. The spec's intent —
 * "do not open cards while the feed is moving" — is preserved exactly; what
 * changes is that the suppression ends properly instead of latching.
 */
const subscribers = new Set<() => void>();

function closeAllOpen(): void {
  // Copy first: a close function removes itself from `open` via `releaseOpen`,
  // and mutating a Set while iterating it is how the last card stays open.
  for (const close of [...open]) close();
}

function onScroll(): void {
  scrolling = true;
  if (scrollTail) clearTimeout(scrollTail);
  scrollTail = setTimeout(() => {
    scrolling = false;
    scrollTail = null;
    // Scrolling has settled. Anything still under the pointer may now arm.
    for (const settled of [...subscribers]) settled();
  }, SCROLL_TAIL_MS);
  // §8: "any open card closes on the first scroll event."
  closeAllOpen();
}

function attach(): void {
  // `capture` for the reason in the header; `passive` because this listener
  // never calls preventDefault and a non-passive scroll listener on the busiest
  // screen in the app is a measurable scroll-jank source.
  document.addEventListener('scroll', onScroll, { capture: true, passive: true });
}

function detach(): void {
  document.removeEventListener('scroll', onScroll, { capture: true } as EventListenerOptions);
  if (scrollTail) {
    clearTimeout(scrollTail);
    scrollTail = null;
  }
  scrolling = false;
}

/**
 * Subscribe a card for the lifetime of its mount. Returns the unsubscribe.
 * Called from an effect, so `document` is always defined by the time it runs.
 */
export function subscribeToScroll(onSettle: () => void): () => void {
  if (subscribers.size === 0) attach();
  subscribers.add(onSettle);
  return () => {
    subscribers.delete(onSettle);
    if (subscribers.size === 0) detach();
  };
}

/** §8: "Pointer entry returns early while it is set." */
export function isScrollSuppressed(): boolean {
  return scrolling;
}

/**
 * §8: "One at a time. Opening a card closes any other." The caller passes its
 * own close function and MUST call `releaseOpen` when it closes by any route.
 */
export function claimOpen(close: () => void): void {
  for (const other of [...open]) if (other !== close) other();
  open.add(close);
}

export function releaseOpen(close: () => void): void {
  open.delete(close);
}

/**
 * §8: "On entry the card measures its own rect. If its bottom edge is within
 * 120px of the viewport bottom, the dwell timer never starts. An expansion that
 * opens offscreen pushes what nobody can see."
 */
export function withinBottomGuard(el: HTMLElement | null): boolean {
  if (!el) return false;
  const { bottom } = el.getBoundingClientRect();
  return window.innerHeight - bottom < BOTTOM_GUARD_PX;
}

/** Test seam. Resets every module-level bit of state. */
export function __resetCardExpansion(): void {
  if (scrollTail) clearTimeout(scrollTail);
  scrollTail = null;
  scrolling = false;
  open.clear();
  subscribers.clear();
}
