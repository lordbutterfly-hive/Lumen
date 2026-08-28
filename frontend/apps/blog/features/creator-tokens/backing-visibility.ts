/**
 * ★★ EVERY BACKING / RESERVE / FLOOR FIGURE IS HIDDEN FOR LAUNCH (owner,
 * 2026-08-27): *"get rid of the backing figure, dont show it, hide it we will
 * activate it some time in the future. again, we're launching i dont want too
 * much shit people wont understand."*
 *
 * WHAT THIS COVERS. Every USER-FACING rendering of the reserve-derived figure,
 * on every surface:
 *
 *   token page   "Reserve backing" headline stat, "Backing per token" headline
 *                stat and its `?` explainer, and the figure the OVERDUE banner
 *                quotes                              (ui/token-page/token-market-view.tsx)
 *   buy dialog   the parenthetical and the clause explaining it
 *                                                    (ui/token-page/token-modals.tsx)
 *   studio       "Floor $x" under Token price, "Floor $x" under Price, the
 *                Reserve stat, and "floor $x" under the creator's own holdings
 *                                                    (ui/studio/creator-studio.tsx)
 *   wallet       the floor-total headline, the per-row "floor $x", and the
 *                sentence that explained it          (ui/your-tokens/your-tokens-view.tsx)
 *   read failure the "price, floor or your balance" sentence
 *                                                    (live/market-states.tsx)
 *
 * WHAT IT DOES NOT COVER, DELIBERATELY. A QUOTE FOR AN ACTION IS NOT A HEADLINE
 * FIGURE. The Sell and Redeem dialogs compute what this holder receives if they
 * press the button (trade-preview.ts, from `refundNetBaseUnits`); that is the
 * price of a transaction they are about to make, not a market statistic, and
 * hiding it would leave someone signing for an amount nobody showed them. Same
 * for the holder's own position row ("$14.44 if this market wound down"): it is
 * this reader's own money on this reader's own tokens, net of their own exit
 * fee, and it is the only figure on the page they could actually receive today.
 * Both stay. See the report note if that call needs revisiting.
 *
 * ★ HIDDEN, NOT DELETED, and behind ONE exported flag rather than a copy per
 * screen. Six switches would be six chances for the figure to come back on the
 * token page while still missing from the wallet, and that failure is SILENT:
 * each call site looks correct on its own. Flipping this single value restores
 * every surface at once, with the original copy, which is why the sentences it
 * turns off are kept verbatim in `ui/token-page/disclosure-copy.ts` rather than
 * rewritten in place.
 *
 * ★ Typed `boolean`, not left to infer `false`: the literal type would mark
 * every guarded branch unreachable and invite a "dead code" cleanup of exactly
 * the JSX and copy this flag exists to preserve.
 *
 * ★ NON-RENDERING, NEVER `display:none`. A hidden-but-present node is still in
 * the accessibility tree, still focusable, and still something every future
 * reader of these files has to reason about. `SHOW_BACKING_FIGURES ? (...) :
 * null` removes the question.
 *
 * ★ THE NUMBERS THEMSELVES ARE UNTOUCHED. `market.floorUsd`, `reserveUsd` and
 * `floorValueHbd` still flow through `live/adapt.ts` and still drive the sell
 * and redeem quotes. This flag governs DISPLAY only; nothing about what a trade
 * pays out changes when it flips.
 *
 * The pattern and its reasoning are `lib/help-visibility.ts` (`SHOW_HELP_LINKS`,
 * owner 2026-08-27) and `features/discovery-feed/medium-post-card.tsx`
 * (`SHOW_CARD_OVERFLOW_MENU`, owner 2026-08-26, "dont delete the code, just
 * hide it").
 */
export const SHOW_BACKING_FIGURES: boolean = false;
