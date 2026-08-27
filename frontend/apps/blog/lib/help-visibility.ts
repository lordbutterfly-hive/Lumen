/**
 * ★★ EVERY USER-FACING ROUTE INTO /help.html IS HIDDEN (owner, 2026-08-27):
 * *"get rid of help as well. theres help on login hide it. i cant deal with this
 * right now. i need to launch."*
 *
 * Help is a support promise. The page itself is accurate, but a "Help" link tells
 * a reader someone is on the other end of it, and at launch nobody is. Taking the
 * link down is the honest move; rewriting the page is not what was asked for.
 *
 * ★ HIDDEN, NOT DELETED, and behind ONE exported flag rather than three
 * module-level copies. Three separate consts would be three switches, and Help
 * would come back on the login screen while still missing from Settings — the
 * failure mode is silent, because each call site would look correct on its own.
 * Flipping this single `true` restores all three at once.
 *
 * The pattern and its reasoning are `features/discovery-feed/medium-post-card.tsx`
 * (`SHOW_CARD_OVERFLOW_MENU`, owner 2026-08-26, "dont delete the code, just hide
 * it"); the shared-module shape is `features/votes/feature-flags.ts`.
 *
 * ★ Typed `boolean`, not left to infer `false`: the literal type would mark every
 * guarded branch unreachable and invite a "dead code" cleanup of the very JSX this
 * flag exists to preserve.
 *
 * ★ THE ROUTE ITSELF STAYS. This hides LINKS. `/help.html` still renders and
 * `next.config.js` still 308s `/help` to it, deliberately — see the dated comment
 * on that redirect: legal and help pages get linked and indexed from outside,
 * where a 404 is not recoverable by the reader, and a *permanent* redirect is
 * already cached in browsers and search indexes that Lumen cannot call back.
 * Unlinking is reversible; 404-ing a URL other sites already point at is not.
 */
export const SHOW_HELP_LINKS: boolean = false;
