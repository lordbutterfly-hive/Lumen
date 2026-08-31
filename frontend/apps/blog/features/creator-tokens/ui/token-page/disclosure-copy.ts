import type { ContractRules } from '../../types';
/**
 * WHAT THE TOKEN PAGE IS ALLOWED TO CLAIM ABOUT MONEY (2026-08-27).
 *
 * Every sentence here was rewritten after a browser audit of the live build
 * (`9k0sWWUqu7AcgaakLJfwI`) read four disclosure defects off the running page
 * at /creators/lumen.beat, supply 50, reserve 60.153 HBD. The numbers quoted in
 * these notes were reproduced against the deployed contract state, not reasoned
 * about: see the four sections below.
 *
 * ★★★ 1. "YOU CAN ALWAYS EXIT" WAS AN UNCONDITIONAL GUARANTEE. The Sell dialog
 * closed with "You can always exit. While this market is open by selling, and
 * once it winds down by redeeming at the floor." — a promise the product's own
 * copy contradicts two panels away ("not a price you can sell at on demand").
 * A bonding curve offers a QUOTED buyback contingent on the reserve being there
 * and the market being open; it cannot promise "always". `exitRoutesNote` now
 * names the two routes and says plainly that neither is a fixed price.
 *
 * ★★★ 2. THE HEADLINE "FLOOR" IS GROSS OF THE EARLY-EXIT FEE. It reads $1.20 on
 * lumen.beat. A holder redeeming inside the first six weeks receives less:
 * $0.96 on day 0, $1.08 on day 21, and only at day 42+ the full $1.20
 * (`refundNetBaseUnits`, reserve 60153, supply 50, verified). The old tooltip
 * said the number was "what the reserve would pay out per token if the market
 * wound down"; for most holders it is not.
 *
 *   ★ AND THE 10% TRADE FEE IS NOT THE REASON. The audit attributed the gap to
 *   the sell fee. It is not: `refundNetBaseUnits`'s own doc says "Unlike Sell
 *   there is NO trade fee here (charging a fee to exit a dying market is
 *   holder-hostile)", and token-modals.tsx has gated the fee row out of redeem
 *   mode since that rail was written. The gap is the exit tax, which happens to
 *   be exactly 10% at day 21 — which is where the audit's $1.08 came from. The
 *   copy names the real cause, because a disclosure that blames the wrong fee
 *   is a second false statement, not a fix.
 *
 * ★★★ 3. "FLOOR" IS NOT A FLOOR, AND THE WORD WAS DOING WORK THE NUMBER CANNOT
 * SUPPORT. It is reserve ÷ supply, and it FALLS as holders leave: at supply 50
 * it is $1.2031, at supply 1 it is $1.0070 (`areaBaseUnits`, exact). A reader
 * seeing "price $1.41 / floor $1.20" infers about 15% of downside; selling into
 * the curve the last holder out nets $0.907, which is 36% down. Renamed to
 * "Backing per token", which is what the quantity IS, and the notes below state
 * the curve behaviour instead of implying a minimum.
 *
 * ★★★ 4. THE FICTION LED AND THE FACT WAS AN ASIDE. "Market cap" (spot × supply,
 * $70) was a headline stat beside the price; "Reserve backing" ($60, the money
 * actually there) was a right-rail card. Nobody can realise a market cap on a
 * bonding curve: selling walks the price back down, and all 50 tokens sold out
 * gross $60.15 and net $54.14. The two have swapped places.
 *
 * WHY A MODULE AND NOT INLINE JSX. Same reason `sell-empty-state.ts` gives:
 * token-market-view.tsx and token-modals.tsx are `'use client'` component trees,
 * so a sentence written inside them is a sentence no test can read. Everything
 * that makes a claim about money lives here, where `disclosure-copy.selftest.ts`
 * can assert on it. This module imports only `market/format` and the launch
 * visibility flag, both pure.
 *
 * HOUSE STYLE. No em or en dashes in any string in this file. The rule is
 * enforced, not just stated: the self-test scans every exported string for
 * U+2014 and U+2013 and fails on either.
 *
 * ★★★ 5. AND THEN THE FIGURE ITSELF WAS HIDDEN FOR LAUNCH (owner, 2026-08-27):
 * *"get rid of the backing figure, dont show it, hide it we will activate it
 * some time in the future ... i dont want too much shit people wont
 * understand."* See ../../backing-visibility.ts.
 *
 * THAT IS A COPY PROBLEM BEFORE IT IS A LAYOUT ONE. Four sentences in this file
 * POINT at the figure: "Backing per token, shown above ...", "Backing per token,
 * shown next to the price ...", the buy dialog's parenthetical, and the overdue
 * banner's quoted number. Hide the stat and leave those, and the page directs a
 * reader to something that is not on it, which is worse than either showing the
 * number or hiding it cleanly.
 *
 * ★ EVERY ORIGINAL SENTENCE IS KEPT, VERBATIM AND STILL EXPORTED. The four
 * affected strings became functions that select between the original and a
 * standalone variant, defaulting to the flag. Nothing is rewritten in place, so
 * flipping `SHOW_BACKING_FIGURES` restores the audited copy exactly as it was
 * rather than whatever a future rewrite would have left behind, and the
 * self-test still asserts on BOTH branches (a hidden branch that nothing checks
 * is a branch that rots).
 *
 * ★ WHAT DELIBERATELY DID NOT CHANGE. `exitRoutesNote`, `WIND_DOWN_BANNER` and
 * `HOW_IT_WORKS_RESERVE_LINE` all talk about "the reserve" as a MECHANISM
 * ("redeem your share of the reserve", "that reserve is what a wind-down pays
 * out"). None of them points at a displayed figure, all of them stay true with
 * the stat gone, and a buyer still needs to know a wind-down pays out of
 * something. `positionSegments` also stays: "$14.44 if this market wound down"
 * is this reader's own money on their own tokens, net of their own exit fee, and
 * it is the one number on the page they could actually receive today.
 */

import { SHOW_BACKING_FIGURES } from '../../backing-visibility';
import { usdPrice } from '../../market/format';

/** The right-rail card: the whole reserve, in dollars. */
export const BACKING_TOTAL_LABEL = 'Reserve backing';

/**
 * The headline stat that used to read "Floor".
 *
 * The quantity is unchanged (`floorPricePerTokenBaseUnits`, i.e. reserve ÷
 * supply); only the name is. "Floor" asserts a minimum. This number has none of
 * a minimum's properties: it moves down when holders sell, it is gross of the
 * seller's own early-exit fee, and it is not obtainable by selling at all.
 */
export const BACKING_PER_TOKEN_LABEL = 'Backing per token';

/** Demoted from the headline to the right rail. See note 4 in the file header. */
export const MARKET_CAP_LABEL = 'Market cap';

/**
 * The `?` explainer beside `BACKING_PER_TOKEN_LABEL`.
 *
 * Three claims, each one checked: the definition, the one route that actually
 * pays it and the deduction that route takes first, and the two things it is
 * NOT (a stable number, and a sale price).
 */
export const BACKING_PER_TOKEN_NOTE =
  'The reserve divided by the tokens issued. If this market wound down, that is what a token would pay out before your early-exit fee. It drops as holders sell, and it is not a price you can sell at.';

/** The same sentence for a screen reader, which gets no label from a `?` glyph. */
export const BACKING_PER_TOKEN_ARIA = `What backing per token means: ${BACKING_PER_TOKEN_NOTE}`;

/**
 * The right-rail caption under the demoted market cap.
 *
 * States the arithmetic and then refuses it, in that order. "The token price
 * times every token issued" rather than naming the figure above, because the
 * headline shows the marginal buy price (`displayPricePerTokenBaseUnits`) and
 * the cap is computed off the oracle spot rate; they agree to the cent at every
 * realistic supply but they are not the same function, and copy should not
 * invite a reader to multiply one by the other.
 */
export const MARKET_CAP_NOTE =
  'The token price times every token issued. No holder can take that out: selling walks the price back down the curve.';

/** The right-rail caption under the reserve total. */
export const BACKING_TOTAL_NOTE = 'The money actually held behind this token. A wind-down pays out of this.';

/**
 * THE VALUE SHOWN FOR `BACKING_PER_TOKEN_LABEL`.
 *
 * ★ A 0 ÷ 0 RENDERED AS "$0.00" ON EVERY UNTRADED MARKET (reproduced 2026-08-27
 * in the browser at /creators/did%3Apkh%3Aeip155%3A1%3A0xB41f…980B, cap 30,
 * supply 0: the page read "Floor ? $0.00"). There is no per-token backing on a
 * market with no tokens, and "$0.00" is not that statement. It is a price, and
 * it reads as one: a token whose backing is worth nothing.
 *
 * The three cases are genuinely different and stay different, the same way
 * `pctLabel` refuses to call a missing total 0% and `usdWholeNonZero` refuses to
 * call 40 cents "$0":
 *
 *     supply <= 0                -> 'None yet'     (nothing issued, nothing backing it)
 *     supply > 0, finite figure  -> '$1.20'        (a real number, including a real $0.00)
 *     supply > 0, no figure      -> 'Unavailable'  (the read failed; a zero would be a lie)
 *
 * A genuine $0.00 with tokens outstanding is a drained reserve, which is
 * alarming and true, so it is still printed.
 */
export function backingPerTokenValue(floorUsd: number, supply: number): string {
  if (!Number.isFinite(supply) || supply <= 0) return 'None yet';
  if (!Number.isFinite(floorUsd)) return 'Unavailable';
  return usdPrice(Math.max(0, floorUsd));
}

/**
 * THE SELL/REDEEM DIALOG'S CLOSING LINE. Replaces "You can always exit."
 *
 * What is actually true: exactly ONE of the two routes is open at a time, the
 * curve one closes when the market winds down (sell.go throws once retired or
 * closed; since A1 a natural FROZEN is an inflow stop, NOT a wind-down, so the
 * curve stays open there — see market/lapse.ts), and neither
 * pays a number anyone has promised in advance. The old line asserted the
 * opposite of the third point and glossed the first.
 */
export function exitRoutesNote(redeem: boolean): string {
  // ★ REWRITTEN 2026-08-30 (studio checklist B3, copy set A). "Your share of
  // the reserve" read as a fixed entitlement and, on the sell line, as if the
  // pool were waiting for the holder. What the contract does (refund.go): the
  // holder must call Redeem themselves, it pays floor(reserve x held / supply)
  // minus the early-exit tax, that is below what they paid at every supply,
  // and the slice shrinks as other holders redeem first. Both sentences now
  // say that, and neither says WHY a market winds down, so they are true on
  // the deployed contract (lapse or Retire) and on the A1 contract (Retire
  // only) alike. The lapse-specific strings ship with the contract release.
  return redeem
    ? 'Redeem pays a pro-rata slice of whatever the reserve holds right now, less your early-exit fee. It is not a refund of what you paid, and the slice shrinks as other holders redeem first. Nothing is paid out unless you do this yourself.'
    : 'While this market is open you sell on the curve. If it winds down, selling closes and the only exit is Redeem: a pro-rata slice of what the reserve holds at that moment, less your early-exit fee, claimed by you. Neither is a fixed price: what you get depends on the curve and on what the reserve holds, and neither is a refund of what you paid.';
}

/**
 * The Buy dialog's risk paragraph. Takes the already-formatted figure so this
 * module never has to know how a market is shaped.
 *
 * ★ The parenthetical is DROPPED when there is no figure to put in it. The very
 * first buy on a market happens at supply 0, where `backingPerTokenValue`
 * returns 'None yet', and "Backing per token (None yet) is the reserve divided
 * by..." is the kind of sentence that reads as a bug on the one screen where a
 * reader is about to spend money.
 */
export function buyRiskNote(backingPerToken: string, showBacking: boolean = SHOW_BACKING_FIGURES): string {
  // ★ WITH THE STAT HIDDEN, THE WHOLE CLAUSE GOES, not just the parenthetical.
  // "Backing per token is the reserve divided by the tokens issued" defines a
  // term this dialog no longer shows anywhere; leaving it would teach a reader
  // a word, on the screen where they are about to spend money, and then never
  // use it. The two risks that are actually actionable on this screen survive
  // untouched: the price floats, and selling soon costs an extra fee.
  if (!showBacking) {
    return 'This token’s price floats and you can lose money. Sell soon after buying and an early-exit fee applies on top of the trade fee.';
  }
  const quoted =
    backingPerToken === 'None yet' || backingPerToken === 'Unavailable' ? '' : ` (${backingPerToken})`;
  return `This token’s price floats and you can lose money. Backing per token${quoted} is the reserve divided by the tokens issued: what a wind-down would pay before your early-exit fee, not a price you can sell at. Sell soon after buying and an early-exit fee applies on top of the trade fee.`;
}

/**
 * THE PAGE'S CLOSING DISCLOSURE, and the only place all four fee and price
 * behaviours are stated together.
 *
 * Every clause is a measured fact, not a hedge:
 *   10% on the curve      tradeFeeOn, both directions (buy and sell)
 *   no fee on a wind-down refundNetBaseUnits, "Unlike Sell there is NO trade fee here"
 *   6 weeks               EXIT_FEE_DAYS = 42, decaying from 20%
 *   the price falls       $1.401 for the first token out at supply 50, $1.007 for the last
 */
export const HONEST_NOTE =
  'This token’s price floats. It can go up or down, and you can lose money. Every trade on the curve pays a 10% fee (5% to the creator, 5% to Lumen), and selling soon after buying adds an early-exit fee on top, which fades to zero over 6 weeks. Backing per token, shown above, is the reserve divided by the tokens issued: what a wind-down would pay before your early-exit fee, with no trade fee on that route. It is not a price you can sell at. Selling into the curve pays the curve’s price, and that price falls as you sell, so the last holder out gets less than the first.';

/**
 * The same paragraph with the two sentences about the hidden stat removed, and
 * NOTHING else touched.
 *
 * "shown above" is the whole problem: with the stat gone it points at nothing.
 * The sentences it introduced went with it rather than being reworded to
 * describe an invisible number, which is what the owner's "shit people won't
 * understand" is about. Every fee fact survives, in the same words, in the same
 * order: the 10% and its split, the 6-week decay, and the cascade that the price
 * falls as you sell.
 */
export const HONEST_NOTE_BACKING_HIDDEN =
  'This token’s price floats. It can go up or down, and you can lose money. Every trade on the curve pays a 10% fee (5% to the creator, 5% to Lumen), and selling soon after buying adds an early-exit fee on top, which fades to zero over 6 weeks. Selling into the curve pays the curve’s price, and that price falls as you sell, so the last holder out gets less than the first.';

/** The closing disclosure the page actually renders. */
export function honestNote(showBacking: boolean = SHOW_BACKING_FIGURES): string {
  return showBacking ? HONEST_NOTE : HONEST_NOTE_BACKING_HIDDEN;
}

/**
 * The third line of the "How this works" rail, and the only one of the three
 * that makes a claim about money.
 *
 * It used to end "The floor is what the reserve would pay out per token if the
 * market wound down", which both used the retired word and stated the gross as
 * if it were the payout.
 *
 * ★ ONLY THIS LINE MOVED. Lines 1 and 2 stay inline in token-market-view.tsx,
 * untouched. Line 2 carries an em dash, and it is PRE-EXISTING microcopy that
 * this pass has no business rewriting: the house rule was applied to copy added
 * or changed today, and lifting an unchanged sentence into a module that
 * enforces the rule would have forced a rewrite nobody asked for.
 */
// ★ 2026-08-30 (B3, copy set A): "that reserve is what a wind-down pays out"
// implied a payout that arrives. It is a pool each holder may CLAIM a pro-rata
// slice of, by acting, less their fee. Mechanism-neutral on purpose (see
// exitRoutesNote's note): true before and after the A1 contract.
export const HOW_IT_WORKS_RESERVE_LINE =
  'As more people buy in, the token can appreciate. Every buy adds to a reserve. If the market ever winds down, that reserve is all there is to redeem against, and each holder can claim a pro-rata slice of it, less their early-exit fee. Selling on the curve is a separate thing, at the curve’s price.';

/**
 * The "Before you trade this token" interstitial, shown once per viewer per
 * market before their first trade.
 *
 * Line 2 used to read "If you buy from the market above the floor, you can get
 * back less than you paid", which is true and understates it: the buy price is
 * ALWAYS above backing per token (a rising convex curve puts the marginal price
 * above the average at every supply), so the condition it appears to warn about
 * is the only condition there is. Line 3 dropped "always" from "not a price you
 * can always sell at": the qualifier invited the reading that there is some
 * other time when you can.
 */
export const INTERSTITIAL_LINES: readonly string[] = [
  'This is a real token whose price goes up and down.',
  'You can get back less than you paid. The price you sell at falls as you sell, and the buy price is always above what the reserve holds per token.',
  'Backing per token, shown next to the price, is the reserve divided by the tokens issued. It is what a wind-down would pay before your early-exit fee, not a price you can sell at.',
  'Selling soon after buying has an early-exit fee that fades to zero over 6 weeks.'
];

/**
 * The interstitial with the stat hidden. THREE lines, not four.
 *
 * Line 3 is dropped outright: "shown next to the price" is a direction to a
 * place on the screen where nothing now is, and it is the only line of the four
 * whose entire subject is the hidden figure.
 *
 * ★ AND LINE 2 LOST ITS TAIL, which is a judgement call worth stating. "the buy
 * price is always above what the reserve holds per token" is TRUE and it was
 * added deliberately (a rising convex curve puts the marginal price above the
 * average at every supply). But it is only meaningful to a reader who knows what
 * the reserve holds per token, and line 3 was where they learned that. Kept
 * without line 3 it is a comparison against an undefined, unshown quantity: the
 * exact "shit people won't understand" the owner asked to remove. The half that
 * a reader can act on, and the half that actually costs them money, is that the
 * price they sell at falls as they sell, and that survives verbatim.
 */
export const INTERSTITIAL_LINES_BACKING_HIDDEN: readonly string[] = [
  'This is a real token whose price goes up and down.',
  'You can get back less than you paid. The price you sell at falls as you sell.',
  'Selling soon after buying has an early-exit fee that fades to zero over 6 weeks.'
];

/** The interstitial the dialog actually renders. */
export function interstitialLines(showBacking: boolean = SHOW_BACKING_FIGURES): readonly string[] {
  return showBacking ? INTERSTITIAL_LINES : INTERSTITIAL_LINES_BACKING_HIDDEN;
}

/** The wind-down banner. Sell is closed here; Redeem is the only door. */
// ★ 2026-08-30 (B3, copy set A): "take your pro-rata share" named a share as if
// it were fixed and waiting. It is a slice of what the reserve holds when you
// act, and nobody is paid out unless they act.
export const WIND_DOWN_BANNER =
  'This creator’s market is winding down, so buying and new asks are closed. Selling on the curve is closed too. You can Redeem for a pro-rata slice of what the reserve holds, less your early-exit fee; nothing is paid out unless you do.';

/**
 * The OVERDUE banner, which is the state where the downside is about to change
 * shape. `figures` is the already-formatted "(currently X a token ...)" clause,
 * or an empty string when the market has no backing figure to quote.
 */
/**
 * ★★★ GATED ON THE CONTRACT THE CHAIN ACTUALLY REPORTS (2026-08-31).
 *
 * This sentence describes what happens to a READER'S MONEY when a creator's
 * listing lapses, and that answer is DIFFERENT under the two rulesets:
 *
 *   v1  the lapse becomes a wind-down. The curve sell closes and the only exit
 *       is the flat pro-rata redeem against the reserve.
 *   v2  the lapse is an inflow stop. Buying closes, the curve sell stays OPEN,
 *       and a renewal reopens buying on the SAME token.
 *
 * It was hard-set to the v2 text, which is the right sentence on the contract we
 * are shipping toward and the WRONG one on the contract deployed today — so on a
 * v1 chain it told a holder their exit was open when it was not. There is no
 * single true wording, which is precisely why it takes `rules` and why there is
 * NO DEFAULT: a default is how this came to state one contract's truth
 * unconditionally in the first place, and a caller that forgets the argument
 * should fail the build rather than quietly pick a ruleset.
 *
 * `rules` comes from `Market.rules`, derived in the data source from the code
 * CID the chain reports — so the sentence follows the chain rather than a flag
 * anyone has to remember to flip at deploy time.
 */
export function overdueBanner(figures: string, rules: ContractRules): string {
  const consequence =
    rules === 'v2'
      ? 'If it isn’t renewed the market stops taking new buyers, but you can still sell on the curve, and the creator can renew any time to reopen buying.'
      : 'If it isn’t renewed the market winds down: the curve closes and the only way out is redeeming your share of the reserve, less your early-exit fee.';
  return `This creator’s listing has lapsed. ${consequence}${figures}`;
}

/**
 * The parenthetical inside `overdueBanner`. Empty when there is nothing to
 * quote, so the sentence never ends "(currently  a token)".
 */
export function overdueFigures(
  backingPerToken: string,
  priceUsd: number,
  showBacking: boolean = SHOW_BACKING_FIGURES
): string {
  // ★ The banner is the one place the backing figure appeared OUTSIDE the stats
  // row, so hiding the stat and not this would have left the number on the page
  // in the single state where it is most alarming. The banner itself stays: the
  // lapse, the freeze and "Redeem is the only way out" are the warning, and none
  // of the three needs the figure to land.
  if (!showBacking) return '';
  if (backingPerToken === 'None yet' || backingPerToken === 'Unavailable') return '';
  return ` (currently ${backingPerToken} a token before your early-exit fee, against ${usdPrice(priceUsd)} now)`;
}

/**
 * The holder's own position line.
 *
 * ★ "worth" WAS THE FICTION WORD. `valueUsd` is tokens × spot price: the same
 * unrealisable mark as the market cap, one row down and called "worth".
 * `floorValueUsd` is the opposite: `readHolderPosition` computes it through
 * `refundNetBaseUnits`, so it is already NET of this holder's own exit tax and
 * is the one figure on the page that a holder could actually receive today.
 * Both are now labelled by what they are.
 */
export interface CopySegment {
  text: string;
  /** Rendered inside a <strong>. The three figures, exactly as before. */
  strong: boolean;
}

/**
 * Segments rather than one string so the row keeps the emphasis it already had
 * on the three numbers. A plain string would have been easier to test and would
 * have silently dropped the <strong> wrappers, which is a presentation
 * regression smuggled in under a copy fix.
 */
export function positionSegments(tokens: string, valueUsd: number, windDownUsd: number): CopySegment[] {
  return [
    { text: 'You hold ', strong: false },
    { text: `${tokens} tokens`, strong: true },
    { text: ' · ', strong: false },
    { text: usdPrice(valueUsd), strong: true },
    { text: ' at today’s price · ', strong: false },
    { text: usdPrice(windDownUsd), strong: true },
    // 2026-08-30 (B3, copy set A): the figure is what a Redeem would pay THIS
    // holder today, net of their fee; "if this market wound down" read as an
    // automatic payout. Same number, honest verb.
    { text: ' if you redeemed at a wind-down today', strong: false }
  ];
}

/** The same row as one string, for the dash sweep and for assertions. */
export function positionLine(tokens: string, valueUsd: number, windDownUsd: number): string {
  return positionSegments(tokens, valueUsd, windDownUsd)
    .map((s) => s.text)
    .join('');
}

/**
 * Every string this module publishes, for the self-test's dash sweep.
 *
 * ★ ENUMERATED FROM THE MODULE, NOT FROM A LIST SOMEONE MAINTAINS BY HAND. A
 * hand-kept list is the failure mode `verify_the_artifact_contains_the_code`
 * describes: it certifies the description instead of the thing. The functions
 * are called with representative arguments so their templates are swept too.
 */
export function allPublishedCopy(): string[] {
  return [
    BACKING_TOTAL_LABEL,
    BACKING_PER_TOKEN_LABEL,
    MARKET_CAP_LABEL,
    BACKING_PER_TOKEN_NOTE,
    BACKING_PER_TOKEN_ARIA,
    MARKET_CAP_NOTE,
    BACKING_TOTAL_NOTE,
    HONEST_NOTE,
    HONEST_NOTE_BACKING_HIDDEN,
    WIND_DOWN_BANNER,
    HOW_IT_WORKS_RESERVE_LINE,
    ...INTERSTITIAL_LINES,
    ...INTERSTITIAL_LINES_BACKING_HIDDEN,
    exitRoutesNote(true),
    exitRoutesNote(false),
    // ★ BOTH BRANCHES OF EVERY FLAGGED STRING. The sweep exists to prove no
    // published sentence carries a dash or the retired word; a variant that only
    // ships when the flag flips is still published, and a sweep that only saw
    // today's branch would certify half the module.
    buyRiskNote('$1.20', true),
    buyRiskNote('$1.20', false),
    // ★ BOTH RULESETS, for this block's own stated reason: a v1 chain publishes
    // the v1 sentence, so a sweep that only saw v2 would certify half of it.
    overdueBanner(overdueFigures('$1.20', 1.408, true), 'v2'),
    overdueBanner(overdueFigures('None yet', 1.007, true), 'v2'),
    overdueBanner(overdueFigures('$1.20', 1.408, false), 'v2'),
    overdueBanner(overdueFigures('$1.20', 1.408, true), 'v1'),
    overdueBanner(overdueFigures('None yet', 1.007, true), 'v1'),
    overdueBanner(overdueFigures('$1.20', 1.408, false), 'v1'),
    positionLine('12.00', 16.9, 14.44),
    backingPerTokenValue(1.203, 50),
    backingPerTokenValue(0, 0),
    backingPerTokenValue(Number.NaN, 50)
  ];
}
