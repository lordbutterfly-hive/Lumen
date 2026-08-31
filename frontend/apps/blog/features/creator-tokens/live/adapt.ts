/**
 * Real chain data -> the USD/token view-models the redesign screens render.
 *
 * WHY THIS FILE EXISTS. The screens were built against `market/store.ts`, an
 * in-memory demo whose numbers vanish on refresh; the audited chain layer
 * (`lib/`, `hooks/`) was fully built and imported by ZERO ui files. Rather than
 * rewrite five screens against a different vocabulary, this module translates
 * chain shapes (HBD, whole tokens, blocks) into the shapes those screens
 * already consume — so the wiring is an import swap plus async handlers, not a
 * redesign.
 *
 * THE RULE THIS FILE OBEYS: never invent a number. Anything the chain cannot
 * answer is `null`/empty here and must render as absent or unavailable
 * upstream — NOT as a zero, a flat line, or a plausible-looking default. Price
 * history, price movement, creator bios and avatars are all in that category
 * today (see LiveTokenMarket's own field docs) — `priceChange` is null unless
 * the indexer actually served two or more points. A demo that lies is a bug we
 * have already shipped once in this feature; a screen that says "not available
 * yet" is not.
 */

import type { Ask, ContractRules, DeliveryRecord as ChainDeliveryRecord, HolderPosition as ChainHolderPosition, Market, Offering, RenewRefusal } from '../types';

import type { DeliveryRecord as UiDeliveryRecord } from '../market/types';
import type { PortfolioAsk } from '../market/portfolio';
import type { Service } from '../market/token-detail';
import { type PriceChange, priceChangeOf } from '../market/price-change';
import { BLOCKS_PER_DAY } from '../lib/contract-math';
import { deliveryMarks } from '../market/format';


/**
 * HBD -> USD. Deliberately 1:1, and deliberately in ONE place.
 *
 * The product's own North Star is "tokens denominated in USD": a creator posts
 * a price, the contract stores it in HBD, and the UI shows a dollar sign. That
 * is sound because HBD is Hive's dollar-pegged asset — the peg IS the mapping,
 * not an approximation of one, and pricing the display off a HIVE/USD feed
 * instead would make a posted $200 service render as $196.40 for no reason a
 * user could understand.
 *
 * THE KNOWN LIMIT, stated rather than hidden: HBD has broken its peg before. If
 * it does again, every figure on these screens is wrong by the depeg. There is
 * no oracle here and no silent correction; if we ever need one, it belongs at
 * this single function and nowhere else.
 */
/**
 * Strip the `hive:` scheme from a chain-side account id for display and for
 * URLs.
 *
 * DEFECT FIX 2026-08-19. The indexer's discovery view returns `creator` in its
 * chain form — `hive:lumen.aria` — because that is what the ledger keys on.
 * The creators listing rendered that value straight into both the visible
 * handle and the href, producing `@hive:lumen.aria` and a link to
 * `/creators/hive:lumen.aria`. The route then URL-encodes the colon and the
 * lookup misses, so EVERY creator card on the discovery page led to
 * "@hive%3Alumen.aria hasn't launched a token" — for markets that demonstrably
 * exist. `/creators/lumen.aria` worked the whole time; only the generated link
 * was wrong, which is why it survived hand-testing by anyone who typed a
 * handle directly.
 *
 * ★ TWO FUNCTIONS, BECAUSE A LINK AND A LABEL WANT DIFFERENT THINGS. `hive:`
 * accounts made them look like one job: strip the scheme and you have both a
 * readable handle and a working route. A wallet creator breaks that. Since
 * 2026-08-20 an EVM identity can launch its own market, and its account id is
 * `did:pkh:eip155:1:0x…` — 68 characters, which rendered on the discovery page
 * as a full-width unreadable `@did:pkh:eip155:1:0xB41f…980B` sitting next to
 * `@lumen.aria`. Truncating it in one place would have been the obvious fix and
 * the wrong one, because the SAME value is the href, and a shortened DID does
 * not resolve.
 *
 * So: `routeHandle` is what goes in a URL, `displayHandle` is what a person
 * reads. Use the wrong one and either the link 404s or the layout breaks.
 */
export function routeHandle(account: string | null | undefined): string {
  if (!account) return '';
  return account.startsWith('hive:') ? account.slice('hive:'.length) : account;
}

/** How long a wallet address reads before it stops being scannable. */
const DID_HEAD = 6;
const DID_TAIL = 4;

/**
 * The human-readable form. `hive:alice` → `alice`; a wallet DID collapses to
 * the familiar `0xB41fEE…980B` shortening every wallet UI uses, so it sits
 * beside a Hive handle instead of dwarfing it. NEVER put this in a URL.
 */
export function displayHandle(account: string | null | undefined): string {
  if (!account) return '';
  if (account.startsWith('hive:')) return account.slice('hive:'.length);

  const address = /^did:pkh:[^:]+:[^:]+:(.+)$/.exec(account)?.[1];
  if (!address) return account;
  // A short address (or an unexpected shape) is left alone rather than being
  // mangled into something shorter than the ellipsis it would replace.
  if (address.length <= DID_HEAD + DID_TAIL + 3) return address;
  return `${address.slice(0, DID_HEAD)}…${address.slice(-DID_TAIL)}`;
}

export function usdFromHbd(hbd: number): number {
  return hbd;
}

/** Blocks -> whole days, rounded down. Used for hold-clock display only, never for money. */
export function blocksToDays(blocks: number): number {
  return Math.max(0, Math.floor(blocks / BLOCKS_PER_DAY));
}

/**
 * The live token-page view-model. Same vocabulary as the demo's
 * TokenMarketDetail, with the demo-only fields made HONESTLY OPTIONAL:
 * everything the chain cannot answer is nullable here and must render as absent.
 */
export interface LiveTokenMarket {
  handle: string;
  /** The contract rules the chain reports (A5 lockstep): v1 vs v2 lapse semantics. */
  rules: ContractRules;
  /** Current price per token, from the curve (spotPriceHbd). */
  priceUsd: number;
  /** Reserve-backed downside per token. Never colored, always beside the price. */
  floorUsd: number;
  marketCapUsd: number;
  reserveUsd: number;
  supply: number;
  cap: number;
  /**
   * Real price history from the indexer (lumen_ct_price_history), oldest first,
   * or NULL when it could not be read. NULL must draw NOTHING — the demo drew a
   * 12-point line from a fixture, and an empty array would draw a flat line;
   * both are claims about how this token has moved.
   *
   * ★ THE FIRST ELEMENT MAY BE THE MARKET'S OPENING PRICE RATHER THAN A TRADE
   * (2026-08-30) — see `readPriceHistory`. Every element is a real price at a
   * real moment either way; what changed is that `chart.length` is no longer a
   * trade count. Anything that states a basis must read `chartTrades`.
   */
  chart: number[] | null;
  /**
   * How many of `chart`'s points are recorded TRADES, or NULL when there is no
   * chart. Never `chart.length`: the series can open with the market's opening
   * supply, which is a price and not a trade. The page's caption and the change
   * indicator both state this number, so a market that has traded once reads
   * "1 trade" beside a two-point line instead of claiming a second trade that
   * never happened.
   */
  chartTrades: number | null;
  /**
   * How far the price has moved across the series `chart` holds, or NULL when
   * that cannot be stated. Derived from the SAME array, so the number and the
   * picture can never disagree; see ../market/price-change.ts for the window and
   * why it is a trade count rather than a clock. Never invented from a single
   * current price.
   */
  priceChange: PriceChange | null;
  delivery: UiDeliveryRecord;
  services: Service[];
  position: LiveHolderPosition | null;
  /** Retired, frozen or closed: Buy is refused, Sell/refund stay open. */
  windingDown: boolean;
  /** RequireInflowOpen — false when paused, winding down, OR the creator is delinquent. */
  canBuy: boolean;
  /**
   * The chain head this market was read against, or NULL when it is not known.
   *
   * ★ THE ONLY HONEST SOURCE FOR "how long until this lapses". `paidUntilAt` and
   * `graceExpiresAt` are milliseconds and comparing them needs a local clock, and
   * `use-live-studio`'s `headOf()` recovers a head from `Date.now()`, which is the
   * same thing wearing a block's clothes. A browser clock must not decide whether
   * someone's market is dying, so the countdown reports UNKNOWN rather than guess.
   *
   * NULL until `Market.headBlock` exists (clauderfly-59 is landing it); the
   * countdown is silent in the meantime and every other lapse state is unaffected,
   * because the chain's own `phase` decides those.
   */
  headBlock: number | null;
  /** market.go kPaidUntil — the block the subscription runs to. Also keys the warning's dismissal, so paying dismisses it. */
  paidUntilBlock: number;
  /** paidUntilBlock + GraceBlocks — the block a lapsed market stops taking buyers. */
  graceExpiresAtBlock: number;
  /** NULL when the chain would accept a subscription payment; otherwise why it would not. See market/lapse.ts. */
  renewRefusal: RenewRefusal | null;
  canAsk: boolean;
  /** Non-null = inflows are shut because the creator ignored too many asks. The UI must say so; a dead button with no reason reads as a broken page. */
  delinquentUntilBlock: number | null;
  phase: Market['phase'];
  /**
   * The creator's posted BASE price (market.go `face`), in dollars.
   *
   * This is the price used for the default "Ask a question" service whenever the
   * creator has posted no named offerings — i.e. for a brand-new market it is
   * the ONLY price a buyer ever sees. It was previously not surfaced anywhere in
   * the studio, so a creator could change every named service's price but never
   * the one their token launched with (2026-08-07).
   */
  basePriceUsd: number;
}

export interface LiveHolderPosition {
  tokens: number;
  /**
   * The maturing half of `tokens` — the only half a curve sell owes exit tax on
   * (core/matured.go:6-13). Optional; omitted means "treat it all as maturing",
   * which overstates the tax rather than understating it. See
   * `HolderPosition.tokensMaturing`.
   */
  maturingTokens?: number;
  valueUsd: number;
  /** NET of this position's own hold-time exit tax — "the least you're guaranteed back". The gross overstates a fresh holder by up to 20%. */
  floorValueUsd: number;
  heldDays: number;
}

/**
 * The chain's delivery record -> the UI's. `available:false` when the indexer
 * could not be reached, which the UI must render as "record unavailable" and
 * must NEVER rank as if it were a perfect record (missing is not perfect — the
 * whole point of ranking on delivery is that an unproven creator does not
 * outrank a proven one by default).
 */
export function adaptDelivery(rec: ChainDeliveryRecord | null | undefined): UiDeliveryRecord {
  if (!rec || rec.source === 'unavailable') {
    return { answered: 0, total: 0, completionPct: null, typicalResponse: '', marks: [], avgRating: null, ratingCount: 0, declinedCount: 0, available: false };
  }
  const total = rec.answeredCount + rec.missedCount;
  // ★ null, NOT 0, when nothing has been asked of this creator yet. Zero is a
  // RESULT ("was asked, did not deliver"); no record is the absence of one, and
  // every market is in this state on its launch day. See DeliveryRecord's own
  // note in ../market/types.ts for what rendering it as 0% did to new creators.
  const completionPct = total === 0 ? null : Math.round((rec.answeredCount / total) * 100);
  return {
    answered: rec.answeredCount,
    total,
    completionPct,
    typicalResponse: typicalResponseLabel(rec.responseBlocks),
    // The chain record carries counts, not an ordered pass/fail history, so the
    // marks strip is reconstructed as "N answered then M missed" — honest about
    // the TOTALS it is drawn from, but NOT a chronology. Do not label it one.
    marks: deliveryMarks(rec.answeredCount, rec.missedCount),
    avgRating: rec.avgRating,
    ratingCount: rec.ratingCount,
    declinedCount: rec.declinedCount,
    available: true
  };
}

/** Median response time as a human label, or '' when there is nothing to summarise. Median, not mean: one abandoned ask must not move it. */
function typicalResponseLabel(responseBlocks: number[]): string {
  if (responseBlocks.length === 0) return '';
  const sorted = [...responseBlocks].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const hours = (median * 3) / 3600; // Hive blocks are 3s
  if (hours < 1) return `~${Math.max(1, Math.round(hours * 60))} minutes`;
  if (hours < 48) return `~${Math.round(hours)} hours`;
  return `~${Math.round(hours / 24)} days`;
}

/**
 * The creator's posted shop -> the UI's Service list.
 *
 * `desc`/`cta` do not exist on-chain: an offering is a title and a price, full
 * stop. They are left generic rather than invented per-service, because a
 * fabricated description of someone's paid work is exactly the kind of detail a
 * user would reasonably believe the creator wrote.
 *
 * Every returned service is 'live'. The demo had a 'rolling_out' state for
 * features that did not exist; a real offering read off the chain is buyable by
 * definition (offerings.go refuses an ask against a deleted or zero-priced id,
 * and listOfferings already filters those out).
 */
export function adaptOfferings(offerings: Offering[]): Service[] {
  return offerings.map((o) => ({
    key: String(o.offeringId),
    name: o.title,
    desc: '',
    usd: usdFromHbd(o.priceHbd),
    status: 'live' as const,
    cta: 'Request'
  }));
}

/**
 * The creator's legacy single `face` price as a Service, for a creator who has
 * posted no named offerings. offeringId 0 is the reserved alias for it
 * on-chain, so this is a real, buyable service and not a placeholder — it is
 * what every ask bought before the shop existed.
 */
export function faceAsService(faceHbd: number): Service[] {
  if (!(faceHbd > 0)) return [];
  return [{ key: '0', name: 'Ask a question', desc: 'One question, answered within your deadline. If it is not, you can reclaim your tokens yourself once the deadline and a short grace period have passed. The creator marks the job delivered, and your protection afterwards is the rating you leave.', usd: usdFromHbd(faceHbd), status: 'live', cta: 'Ask' }];
}

/**
 * `spotPriceUsd` is required because HolderPosition carries no market value of
 * its own — only the token count and the TAXED floor. Marking a position to
 * market is a curve question, so the price has to come from the Market read
 * alongside it, and passing it explicitly keeps that dependency visible rather
 * than re-deriving a second, possibly-different price in here.
 */
export function adaptPosition(pos: ChainHolderPosition | null, spotPriceUsd: number): LiveHolderPosition | null {
  if (!pos || pos.tokensHeld <= 0) return null;
  return {
    tokens: pos.tokensHeld,
    // ★ 2026-08-27: without this the LOCAL sell preview taxes the whole position
    // and understates a mixed holder's payout by up to 17.1% (measured: 100
    // tokens from 40 maturing / 60 matured at supply 1000, h=0). `quoteSell` on
    // the chain path was fixed the same day; this is the preview half.
    maturingTokens: pos.tokensMaturing,
    valueUsd: pos.tokensHeld * spotPriceUsd,
    floorValueUsd: usdFromHbd(pos.floorValueHbd),
    // heldBlocks is already the hold clock as of the read's block — an UNSET
    // clock reads 0, i.e. maximally FRESH (maximum exit tax), never ancient.
    heldDays: blocksToDays(pos.heldBlocks)
  };
}

export function adaptMarket(input: {
  creator: string;
  market: Market;
  position: ChainHolderPosition | null;
  offerings: Offering[];
  delivery: ChainDeliveryRecord | null;
  /** Oldest-first prices, or null when unavailable. May open with the market's opening price — see `priceTrades`. */
  priceHistory?: number[] | null;
  /**
   * How many of `priceHistory`'s points are recorded TRADES. Omit only when
   * every point is one. The caller knows this because it holds the `PricePoint`
   * rows, which flag the opening point; by the time the array of bare numbers
   * gets here that information is gone, so it has to be carried alongside.
   */
  priceTrades?: number | null;
}): LiveTokenMarket {
  const { creator, market, position, offerings, delivery, priceHistory, priceTrades } = input;
  const services = offerings.length > 0 ? adaptOfferings(offerings) : faceAsService(market.faceHbd);
  // Derived ONCE in the data source under the contract rules the chain
  // reports (types.ts Market.windingDown, 2026-08-31 A5); this line used to
  // restate the v1 predicate inline, then call market-health's copy of it.
  const windingDown = market.windingDown;
  return {
    handle: creator,
    rules: market.rules,
    priceUsd: usdFromHbd(market.spotPriceHbd),
    basePriceUsd: usdFromHbd(market.faceHbd),
    floorUsd: usdFromHbd(market.floorPriceHbd),
    marketCapUsd: usdFromHbd(market.spotPriceHbd * market.supplyTokens),
    reserveUsd: usdFromHbd(market.reserveHbd),
    supply: market.supplyTokens,
    cap: market.capTokens,
    // A single point is not a chart — it would render as a flat line, implying
    // a price that held steady when in fact we only know one moment.
    //
    // ★ THE FLOOR IS UNCHANGED, AND THAT IS THE POINT (2026-08-30). The bug the
    // owner reported ("theres no chart in the market", reproduced on a SOLD-OUT
    // market) was never this guard being too strict: it was the series arriving
    // one point short, because a trade row records only where supply LANDED.
    // `readPriceHistory` now supplies the state it started FROM as well, so a
    // one-trade market clears this floor with two real prices rather than by
    // the floor being lowered to draw a line through one.
    chart: priceHistory && priceHistory.length >= 2 ? priceHistory : null,
    chartTrades: priceHistory && priceHistory.length >= 2 ? (priceTrades ?? priceHistory.length) : null,
    // ★ THE CHANGE IS DERIVED FROM THE CHART'S OWN ARRAY, and it is the SAME
    // array, not a second read: whatever the chart draws rising by a third, the
    // indicator says rose by a third. `priceChangeOf` applies the identical
    // two-point floor, so the figure and the chart appear and disappear
    // together — a percentage beside an empty chart slot would be unverifiable
    // by the only reader who can check it. The trade count rides along so the
    // BASIS it states ("over 1 trade") counts trades and not points.
    priceChange: priceChangeOf(priceHistory ?? null, priceTrades ?? null),
    delivery: adaptDelivery(delivery),
    services,
    position: adaptPosition(position, usdFromHbd(market.spotPriceHbd)),
    windingDown,
    canBuy: market.canBuy,
    canAsk: market.canAsk,
    headBlock: market.headBlock,
    paidUntilBlock: market.paidUntilBlock,
    graceExpiresAtBlock: market.graceExpiresAtBlock,
    renewRefusal: market.renewRefusal,
    delinquentUntilBlock: market.delinquentUntilBlock,
    phase: market.phase
  };
}

/**
 * A chain escrow -> the portfolio/inbox row.
 *
 * The chain does NOT store the question text or the answer text — only content
 * hashes — and no hash-resolution layer exists yet, so `question`/`answer` are
 * deliberately absent rather than filled with the hash. Showing a user
 * "QmXf9..." where their own question should be is worse than showing nothing.
 */
export function adaptAsk(ask: Ask, priceUsdPerToken: number): PortfolioAsk {
  return {
    id: ask.id,
    handle: ask.creator,
    // Which named offering this was is not stored on the escrow record, so the
    // row cannot claim a specific service name.
    service: 'Ask',
    state: adaptAskState(ask.status),
    costUsd: usdFromHbd(ask.tokensEscrowed * priceUsdPerToken),
    tokens: ask.tokensEscrowed,
    dueLabel: dueLabelFor(ask),
    urgent: ask.status === 'awaiting' && ask.deadlineAt - Date.now() < 24 * 3600 * 1000
  };
}

/**
 * AskStatus -> the portfolio's narrower AskState.
 *
 * 'expired' (the dead zone between the deadline and the reclaim window opening)
 * maps to 'awaiting': from the holder's point of view nothing has resolved and
 * nothing is actionable yet, which is exactly what awaiting means to them.
 * 'declined' maps to 'reclaimed' — both are "the money came back", and the
 * portfolio has no separate cell for the distinction. The DELIVERY RECORD is
 * where declines are counted separately, and that difference must survive
 * there, so never collapse the two upstream of this function.
 */
function adaptAskState(status: Ask['status']): PortfolioAsk['state'] {
  switch (status) {
    case 'answered':
      return 'answered';
    case 'reclaimable':
      return 'reclaimable';
    case 'reclaimed':
    case 'declined':
      return 'reclaimed';
    default:
      return 'awaiting';
  }
}

/**
 * Exported 2026-08-23 for the Studio's AnswerModal (A14). That modal asks a creator to
 * commit to a job and never showed them the clock, while `ask.deadlineBlock` sat on the
 * very object it passes to `studio.answer()`. Missing the deadline records a miss against
 * the creator (`core/ask.go` recordMiss), so the one screen where they decide whether to
 * take the work is the screen that most needs the number. One formatter, not two.
 *
 * Returns undefined for a non-awaiting ask and for one already past its deadline — the
 * caller decides what to say about those, since "due in -3h" is not a sentence.
 */
export function dueLabelFor(ask: Ask): string | undefined {
  if (ask.status !== 'awaiting') return undefined;
  const ms = ask.deadlineAt - Date.now();
  if (ms <= 0) return undefined;
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 24) return `Answer due in ${Math.max(1, hours)}h`;
  return `Answer due in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}
