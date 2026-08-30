/**
 * ONE WORD FOR "CAN THIS MARKET TAKE A BUYER'S MONEY RIGHT NOW", for the small
 * surfaces that have room for one word and no room for a banner.
 *
 * ★★ WHY THIS EXISTS (2026-08-30, studio checklist B4). Five surfaces drew a
 * price and a Buy affordance off a market read and never looked at its phase:
 * the profile token card (ui/profile-token-card.tsx), the post-page byline chip
 * (ui/token-author-chip.tsx), the header pill (ui/header-token-pill.tsx), the
 * account-menu line (layouts/site-header/user-menu.tsx) and the feed identity
 * pill on EVERY card (discovery-feed/identity-pill.tsx). `use-token-price-chip
 * .ts` collapsed only UNKNOWN, so a FROZEN or CLOSED market returned a normal
 * price, and `readMarketPrices` (the feed's batched read) read supply, state
 * and registeredAt and nothing else, so it could not have known. Every one of
 * them rendered "$1.41 · Buy" for a curve the contract refuses to sell on.
 *
 * The token page is the only screen that knew: it gates Buy on `market.canBuy`
 * and shows the OVERDUE / wind-down / delinquent banners
 * (token-market-view.tsx:495-530, :690). A reader who never opens the token
 * page, which is what a feed chip is FOR, never saw any of it.
 *
 * THE RULE IS THE TOKEN PAGE'S OWN, restated for a one-word surface:
 *   closed   winding down: retiredAtBlock set, or phase CLOSED, or (under the
 *            v1 contract rules only) a natural FROZEN. `windingDownOf` below
 *            is that predicate under the rules the chain reports
 *            (market/contract-rules.ts); both data sources derive
 *            `Market.windingDown` from it once. The curve is shut and
 *            sell.go refuses; never draw Buy.
 *   delisted a natural FROZEN under the v2 rules (A1, 2026-08-30): the chain
 *            refuses Buy and Ask, holders keep the curve, the creator can pay
 *            to relist. The app-side delisting the owner asked for, as one
 *            word. Unreachable under v1, where the same phase is `closed`.
 *   paused   canBuy false for any OTHER reason: the creator is delinquent
 *            (delivery.go) or the global inflow pause is on. Never draw Buy.
 *   lapsed   phase OVERDUE and still buyable. The contract accepts the buy
 *            (RequireInflowOpen treats OVERDUE as ACTIVE) and the token page
 *            keeps Buy enabled under a warning banner, so a small surface
 *            says the one word the banner would have said instead of
 *            pretending nothing is wrong. NO product decision is taken here:
 *            whether a lapsed market should be DELISTED in the app is the
 *            open A1 question on the checklist, and this word is what a small
 *            surface shows in the meantime either way.
 *   open     everything else.
 *
 * Order matters and mirrors the token page: a retired market in its OVERDUE
 * notice window is `closed`, not `lapsed`, because RULING K3 shuts inflows
 * from the retire block (types.ts, Market.canBuy doc).
 *
 * Pure. Lives in market/ (not ui/, not live/) because both data sources, both
 * price hooks and five UI files need the identical answer, and three variants
 * of the same predicate is how the phase went unchecked on five surfaces in
 * the first place.
 */

import type { ContractRules, MarketHealth, MarketPhase } from '../types';
import { windingDownUnder } from './contract-rules';

/**
 * The wind-down predicate under the rules the chain reports: retired or
 * closed, and under v1 a natural FROZEN as well. One place, greppable. Takes
 * `rules` as an input on purpose: a caller that has a `Market` should read
 * `market.windingDown` (derived from this once, in the data source) and only
 * the two data sources and their batched reads call this directly.
 */
export function windingDownOf(m: { phase: MarketPhase; retiredAtBlock: number | null; rules: ContractRules }): boolean {
  return windingDownUnder(m.rules, m);
}

/**
 * The one word. `windingDown` is taken as an input rather than re-derived so
 * the already-shaped `LiveTokenMarket` (which carries `windingDown` and not
 * `retiredAtBlock`) and the raw chain `Market` (the reverse) both fit without
 * a second signature.
 */
export function marketHealthOf(m: { phase: MarketPhase; canBuy: boolean; windingDown: boolean }): MarketHealth {
  if (m.windingDown) return 'closed';
  // A FROZEN market that is NOT winding down exists only under the v2 rules
  // (contract-rules.ts windingDownUnder), so no rules input is needed here:
  // the wind-down line above has already said which contract this is.
  if (m.phase === 'FROZEN') return 'delisted';
  if (!m.canBuy) return 'paused';
  if (m.phase === 'OVERDUE') return 'lapsed';
  return 'open';
}

/**
 * ★ SOLD OUT IS AN ACTION FACT, NOT A HEALTH (owner, 2026-08-30: "on hbd temp
 * pill says sold out. thats stupid and wrong. fix that as well. thats a bug").
 *
 * For about an hour this was a fifth MarketHealth, 'sold-out', found on the
 * running build: hbd-temp (30 of 30 issued) drew "$1.25 · Buy" while the
 * token page's own button read "Sold out", because sold-out is not part of
 * canBuy (RequireInflowOpen never looks at the cap; buy.go:114-121 does).
 * The FACT is true and the chain confirms it. The owner's objection is to the
 * KIND of statement: lapsed / closed / paused say something is wrong with the
 * creator, and rendering a paid-up ACTIVE creator inside the same amber
 * warning panel because a legacy supply ceiling was reached is wrong. It is
 * also the last surviving expression of a cap the product deleted from every
 * other surface today, reachable only on three legacy testnet markets whose
 * caps nobody chose on purpose (a MaxCap market can never reach it).
 *
 * So: health stays four words; sold-out is this boolean, and it governs ONLY
 * the Buy control — which must still not be offered when every buy reverts
 * (that is the dead-control fault B4 exists to end). Where Buy would have
 * been, the surface draws SOLD_OUT_WORD, the token page's own button label
 * (token-market-view.tsx `soldOut ? 'Sold out' : 'Buy'`), in the Buy slot's
 * ordinary styling, with no warning line and no amber. Only surfaces that
 * already hold supply AND cap judge it; the batched feed read does not (no
 * 7th key for a state that is going away: the cure is the owner raising that
 * market's cap with setCap).
 *
 * `supply >= cap`, never `===`: a cap lowered below supply must not re-open
 * buying (token-market-view.tsx:146).
 */
export function soldOutOf(m: { supply: number; cap: number }): boolean {
  return m.cap > 0 && m.supply >= m.cap;
}

/** The token page's own Buy-button label for a sold-out market, reused verbatim so every surface says the same word. */
export const SOLD_OUT_WORD = 'Sold out';

// TODO i18n — staged copy, same precedent as the rest of this feature's UI
// strings (labels.ts's own doc explains why).
const BUY = 'Buy';
const HEALTH_WORD: Record<Exclude<MarketHealth, 'open'>, string> = {
  lapsed: 'Lapsed',
  delisted: 'Delisted',
  closed: 'Closed',
  paused: 'Paused'
};

/**
 * What a chip draws in the slot that used to be hard-wired to "Buy": the
 * action when the market is open, the state when it is not. Capitalised
 * single words on purpose, so the slot keeps its width and a reader scanning a
 * feed sees the difference without reading a sentence.
 */
export function buyWordFor(health: MarketHealth): string {
  return health === 'open' ? BUY : HEALTH_WORD[health];
}

/** The state word alone, or null when there is nothing to warn about. For surfaces with no Buy slot (the header pill, the account menu). */
export function healthWordFor(health: MarketHealth): string | null {
  return health === 'open' ? null : HEALTH_WORD[health];
}
