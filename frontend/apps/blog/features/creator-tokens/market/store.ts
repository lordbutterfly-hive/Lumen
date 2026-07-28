'use client';

import { useSyncExternalStore } from 'react';
import type { CreatorTokenSummary } from './types';
import type { TokenHolding, PortfolioAsk } from './portfolio';
import type { TokenMarketDetail, HolderPosition, Service } from './token-detail';
import { MOCK_TOKEN_DETAIL } from './token-detail';
import { MOCK_CREATORS, MOCK_NEW_CREATORS } from './mock';
import { MOCK_HOLDINGS, MOCK_ASKS } from './portfolio';
import { buyQuote, sellQuote, serviceQuote, spotPriceUsd, reserveUsdAt, floorValueUsdNet } from './curve';

/**
 * Client-side, stateful mock of the creator-token markets — the LOCAL backing for
 * the token screens until the bonding-curve contract is deployed and the indexer
 * serves live reads (then this is swapped for an indexer/contract data source
 * behind the same {market, buy, sell, spend} shape). Buy/sell/spend mutate an
 * in-memory market via the curve helpers in curve.ts and notify subscribers, so
 * the page reflects the new price/supply/floor/position immediately. Not money —
 * a UI-faithful demo store.
 */

const DEFAULT_SERVICES: Service[] = [
  { key: 'ask', name: 'Ask a question', desc: 'One private question, answered within your deadline — or your tokens back.', usd: 10, status: 'live', cta: 'Ask' },
  { key: 'review', name: 'Review my work', desc: 'A written review of a repo, doc or plan.', usd: 80, status: 'live', cta: 'Request' },
  { key: 'opinion', name: 'Give your opinion', desc: 'A candid take on your idea, plan or design.', usd: 25, status: 'live', cta: 'Ask' }
];

/**
 * ★ CURVE-CONSISTENT SEED (2026-07-24). The supply is taken from the
 * fixture's market cap, but the PRICE and the RESERVE are then DERIVED from
 * the curve at that supply rather than carried over from the fixture:
 *
 *   price  = SpotRate(S)   the marginal price the curve actually charges
 *   reserve = Area(S)      the exact backing the mechanism guarantees
 *
 * The old seed set reserve = 50% of market cap, which put every mock market
 * in a state the real contract cannot reach — R === Area(S) holds with
 * EQUALITY at every reachable trading state. A demo seeded below its own
 * curve shows a floor price that could never occur and makes the wind-down
 * maths look profitable when the governing theorem proves it never is.
 */
function synthDetail(c: CreatorTokenSummary): TokenMarketDetail {
  const supply = Math.max(1, Math.round(c.marketCapUsd / Math.max(c.priceUsd, 0.01)));
  const priceUsd = round2(spotPriceUsd(supply));
  const reserveUsd = round2(reserveUsdAt(supply));
  return {
    handle: c.handle,
    what: c.what,
    avatarColor: c.avatarColor,
    reputation: Math.max(25, Math.round(c.delivery.completionPct * 0.8)),
    priceUsd,
    changePctWeek: 0,
    marketCapUsd: Math.round(supply * priceUsd),
    floorUsd: round2(reserveUsd / supply),
    supply,
    cap: Math.max(supply * 2, 10000),
    reserveUsd,
    chart: Array.from({ length: 12 }, (_, i) => round2(priceUsd * (0.9 + (0.1 * i) / 11))),
    delivery: c.delivery,
    services: DEFAULT_SERVICES,
    position: null
  };
}

// The viewer's OWN creator token handle (managed in the Studio, excluded from
// the public Discovery grid + the "holdings of others" portfolio).
export const STUDIO_HANDLE = 'you';

// Seed: @ada now goes through the SAME curve-consistent synthDetail() path as
// every other creator (2026-07-27 fix) — it used to seed straight from
// MOCK_TOKEN_DETAIL's own hand-picked money numbers (price $4.20, reserve
// $42,000 at supply 20,000), figures the curve cannot produce at that supply
// (Area(20,000) ≈ $8.6M, SpotRate(20,000) ≈ $1,208.50/token — curve.go
// Area/SpotRate). The summary below carries MOCK_TOKEN_DETAIL's own non-money
// fields; its OLD priceUsd/marketCapUsd pair is fed in ONLY to imply the
// target supply (exactly how synthDetail derives every other creator's
// supply), and synthDetail then re-derives price/floor/reserve from the
// curve. The one hand-authored field synthDetail's generic DEFAULT_SERVICES
// can't replicate — @ada's richer 5-item services catalogue — is kept on top.
const markets = new Map<string, TokenMarketDetail>();
const adaSummary: CreatorTokenSummary = {
  handle: MOCK_TOKEN_DETAIL.handle,
  what: MOCK_TOKEN_DETAIL.what,
  avatarColor: MOCK_TOKEN_DETAIL.avatarColor,
  fromPriceUsd: Math.min(...MOCK_TOKEN_DETAIL.services.filter((s) => s.status === 'live').map((s) => s.usd)),
  priceUsd: MOCK_TOKEN_DETAIL.priceUsd,
  marketCapUsd: MOCK_TOKEN_DETAIL.marketCapUsd,
  delivery: MOCK_TOKEN_DETAIL.delivery
};
markets.set(MOCK_TOKEN_DETAIL.handle, { ...synthDetail(adaSummary), services: MOCK_TOKEN_DETAIL.services });
for (const c of [...MOCK_CREATORS, ...MOCK_NEW_CREATORS]) {
  if (!markets.has(c.handle)) markets.set(c.handle, synthDetail(c));
}
// Seed the viewer's starting portfolio so Your-Tokens is populated up front and
// then tracks live trades (a buy adds/increases a position, a sell reduces it).
// value/floor are DERIVED from each market's own live price/floor via
// withPosition (which nets the K2 exit tax — see its own doc), never trusted
// as raw numbers off the fixture: MOCK_HOLDINGS' own valueUsd/floorValueUsd
// were hand-computed against each creator's OLD seed price and would silently
// drift from a curve-consistent reseed (exactly the @ada defect fixed above).
for (const h of MOCK_HOLDINGS) {
  const m = markets.get(h.handle);
  if (m) {
    m.position = withPosition(m, h.tokens, 30);
    if (h.windingDown) m.windingDown = true;
  }
}

const listeners = new Set<() => void>();

// Asks (escrowed service requests). Seeded with example lifecycle states; a new
// ask the viewer creates is prepended as 'awaiting'. asksSnapshot is the stable
// ref useSyncExternalStore returns, rebuilt on every notify.
let asksList: PortfolioAsk[] = [...MOCK_ASKS];
let asksSnapshot: PortfolioAsk[] = asksList;
// Only the viewer's OUTGOING asks (to other creators) — the Studio's INCOMING
// inbox items (handle === STUDIO_HANDLE) must NOT show in the Portfolio Asks tab (#1).
let outgoingAsksSnapshot: PortfolioAsk[] = asksList.filter((a) => a.handle !== STUDIO_HANDLE);
let askSeq = 1000;

// Studio module state — declared BEFORE emit() so emit can rebuild the studio
// snapshot with no forward temporal-dead-zone reference (#5). buildStudioRaw is a
// hoisted function; the seed block below re-runs it once the own-token is seeded.
let subDaysLeft = 24;
let tradeFeeClaimableUsd = 0;
let commissionEarnedUsd = 0;
let launched = false; // no token until the wizard launches one (spec's no-token → launch → studio); #11
let studioSnapshot: StudioState = buildStudioRaw();

function emit() {
  rebuildCaches();
  asksSnapshot = asksList.slice();
  outgoingAsksSnapshot = asksList.filter((a) => a.handle !== STUDIO_HANDLE);
  studioSnapshot = buildStudioRaw();
  for (const l of listeners) l();
}
function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function withPosition(m: TokenMarketDetail, tokens: number, heldDays: number): HolderPosition | null {
  if (tokens <= 0.0001) return null;
  return {
    tokens: round2(tokens),
    valueUsd: round2(tokens * m.priceUsd),
    // NET of the K2 exit tax for THIS position's own hold age — matches
    // lib/vsc-data-source.ts's readHolderPosition (refundNetBaseUnits). The
    // untaxed GROSS (tokens * m.floorUsd) overstates a fresh holder's payout
    // by up to 20% while the UI calls this "the least you're guaranteed
    // back" (floorValueUsdNet's own doc has the full reasoning).
    floorValueUsd: round2(floorValueUsdNet(tokens, m.floorUsd, heldDays)),
    heldDays
  };
}

function reprice(m: TokenMarketDetail): TokenMarketDetail {
  const marketCapUsd = Math.round(m.supply * m.priceUsd);
  const floorUsd = m.supply > 0 ? round2(m.reserveUsd / m.supply) : 0;
  const chart = [...m.chart.slice(-11), m.priceUsd];
  // #8: recompute the "this week" badge from the chart window so it moves with the
  // price instead of freezing at the seed value.
  const base = chart[0];
  const changePctWeek = base > 0 ? Math.round(((m.priceUsd - base) / base) * 1000) / 10 : m.changePctWeek;
  const position = m.position ? withPosition({ ...m, floorUsd }, m.position.tokens, m.position.heldDays) : null;
  return { ...m, marketCapUsd, floorUsd, changePctWeek, chart, position };
}

// A brand-new market for an as-yet-unseen handle — synthesised keyed by the REAL
// handle (never another creator's data), so an unknown /creators/<x> (the Creator
// Studio link, a hand-typed URL) renders a coherent page instead of @delm.
function defaultDetail(handle: string): TokenMarketDetail {
  // Curve-consistent, same reasoning as synthDetail: price and reserve are
  // DERIVED at S = 1000, never hand-picked. (Area(1000) is ~4.9M base units
  // = ~$4,940, not the $500 this used to claim — the old seed was under its
  // own curve by an order of magnitude.)
  const supply = 1000;
  const priceUsd = round2(spotPriceUsd(supply));
  const reserveUsd = round2(reserveUsdAt(supply));
  return {
    handle,
    what: 'Creator token',
    avatarColor: 'linear-gradient(135deg,#6b7280,#9ca3af)',
    reputation: 25,
    priceUsd,
    changePctWeek: 0,
    marketCapUsd: Math.round(supply * priceUsd),
    floorUsd: round2(reserveUsd / supply),
    supply,
    cap: 10000,
    reserveUsd,
    chart: Array.from({ length: 12 }, () => priceUsd),
    delivery: { answered: 0, total: 0, completionPct: 0, typicalResponse: '', marks: [], available: false },
    services: DEFAULT_SERVICES,
    position: null
  };
}

// Lazy-seed: an unseen handle is inserted ONCE and thereafter returns the SAME
// object reference — required by useSyncExternalStore, which loops if getSnapshot
// returns a fresh object each call (C1). Never mutates an existing entry.
export function getMarket(handle: string): TokenMarketDetail {
  let m = markets.get(handle);
  if (!m) {
    m = defaultDetail(handle);
    markets.set(handle, m);
  }
  return m;
}

// Server-side read: NEVER inserts. getServerSnapshot runs on the Node server for
// every SSR request; inserting there would leak the module-level Map unbounded
// when a crawler hits distinct handles (#2). Returns the seeded market or a
// transient default with the SAME deterministic values, so hydration still matches.
function getMarketReadonly(handle: string): TokenMarketDetail {
  return markets.get(handle) ?? defaultDetail(handle);
}

/**
 * Buy up to `usdGross` worth of the token (the 10% trade fee is included in
 * that budget). Returns whether the buy actually executed — the caller
 * (BuyModal) must check this before treating a click as a success; a refusal
 * (wind-down closed, cap exhausted, a budget too small to afford one token,
 * or the buyer's own slippage ceiling tripped) mutates NOTHING and must not
 * be presented as if it did.
 *
 * ★ INTEGER TOKENS (curve pivot): the curve mints whole tokens only, so the
 * budget buys the largest whole count that fits and the ACTUAL cost
 * (`q.totalUsd`) is at most the budget. The reserve is credited the curve leg
 * alone — crediting the fee too would break the R === Area(S) equality that
 * the whole mechanism rests on (buy.go: "booking the fee into the reserve
 * would break R === area(S)").
 *
 * maxTotalUsd (OPTIONAL): the buyer's own signed ceiling on TotalDue — the
 * modal's "max price per token" control converted to a total-cost bound (the
 * mock's stand-in for buy.go's own doc: "slippage protection is the buyer's
 * own signed transfer.allow on that draw"). Refuses rather than silently
 * buying at a worse price than the buyer signed up for.
 */
export function buy(handle: string, usdGross: number, maxTotalUsd?: number): boolean {
  if (handle === STUDIO_HANDLE) return false; // #2: you can't buy your own token — no self-dealing
  const m = getMarket(handle);
  // buy.go RequireInflowOpen (RULING K3): a retired/winding-down market
  // refuses EVERY new inflow for its whole wind-down — enforced here, not
  // just via the main Buy button's own disabled state (that's UI, not a gate).
  if (m.windingDown) return false;
  if (!Number.isFinite(usdGross) || usdGross <= 0) return false;
  usdGross = Math.min(usdGross, 1_000_000); // ceiling — a fat-finger 1e999 must not poison the market to NaN (H1)
  const q = buyQuote(usdGross, m); // cap-aware: never quotes past m.cap (curve.ts's own doc)
  if (!Number.isFinite(q.tokens) || q.tokens < 1) return false; // a too-small budget (or an exhausted cap) buys nothing
  if (maxTotalUsd !== undefined && q.totalUsd > maxTotalUsd) return false; // the buyer's own signed slippage ceiling
  const supply = Math.floor(m.supply) + q.tokens;
  if (supply > m.cap) return false; // defense-in-depth: buyQuote's own cap clamp should make this unreachable
  const priceUsd = Math.max(0.01, round2(q.priceAfter));
  // Curve leg only: totalUsd − fee == the exact area step Area(S+n) − Area(S).
  const reserveUsd = m.reserveUsd + (q.totalUsd - q.tradeFeeUsd);
  const oldTokens = m.position?.tokens ?? 0;
  const heldTokens = oldTokens + q.tokens;
  // #3: acquisition-WEIGHTED hold age — new tokens enter at age 0, existing tokens
  // keep theirs, so a top-up doesn't reset the whole position's early-exit clock.
  // This mirrors holdclock.go's creditInflow: an inflow always drags the clock
  // TOWARD now, so a fresh or sybil account can never look aged.
  const heldDays = heldTokens > 0 ? Math.round((oldTokens * (m.position?.heldDays ?? 0)) / heldTokens) : 0;
  const next = reprice({ ...m, supply, priceUsd, reserveUsd, position: withPosition({ ...m, priceUsd }, heldTokens, heldDays) });
  markets.set(handle, next);
  emit();
  return true;
}

/**
 * Sell `tokens` back to the curve. Whole tokens only; the exit tax and the
 * 10% trade fee are both charged on the GROSS curve proceeds, and the reserve
 * is debited that same gross amount (sell.go — the tax goes to the treasury
 * and the fee to the two pull pots, neither comes out of the reserve's own
 * area obligation).
 *
 * The post-trade price is read from the CURVE at the new supply, not nudged
 * from the old price by a ratio: the curve is the price source.
 *
 * Returns whether the sell actually executed. Every refusal below is SILENT —
 * it mutates nothing — so a caller that closes its modal regardless reports a
 * sale that never happened (the same defect buy() was fixed for; see its doc).
 */
export function sell(handle: string, tokens: number): boolean {
  const m = getMarket(handle);
  if (!Number.isFinite(tokens)) return false;
  const held = m.position?.tokens ?? 0;
  const n = Math.floor(Math.min(tokens, held, Math.floor(m.supply)));
  if (n <= 0) return false; // nothing held, or a sub-1-token request (whole tokens only)
  const q = sellQuote(n, m, m.position?.heldDays ?? 999);
  if (q.curveProceedsUsd <= 0) return false;
  const supply = Math.max(0, Math.floor(m.supply) - n);
  const priceUsd = Math.max(0.01, round2(supply > 0 ? spotPriceUsd(supply) : m.floorUsd));
  const reserveUsd = Math.max(0, m.reserveUsd - q.curveProceedsUsd);
  const next = reprice({ ...m, supply, priceUsd, reserveUsd, position: withPosition({ ...m, priceUsd }, held - n, m.position?.heldDays ?? 0) });
  markets.set(handle, next);
  emit();
  return true;
}

/**
 * Spend on a USD-priced service. USER RULING 2026-07-27: `usd` is the
 * buyer's TOTAL — only the 88% TOKEN LEG is escrowed here (serviceQuote,
 * ask.go splitFace); the remaining 12% is a separate HBD commission this mock
 * has no wallet balance to draw from (see AskModal's own note on the
 * affordability gate it can't fully verify).
 *
 * Returns whether the ask actually opened — a refusal (self-ask, wind-down,
 * a bad amount, or insufficient token balance) mutates NOTHING and must not
 * be presented as if the ask went out (the same defect buy() was fixed for).
 */
export function spend(handle: string, usd: number, serviceName = 'Ask a question', deadlineDays = 7, question = ''): boolean {
  if (handle === STUDIO_HANDLE) return false; // #2: can't ask your own token (would let you answer yourself for commission)
  const m = getMarket(handle);
  // ask.go Ask -> RequireInflowOpen: the SAME inflow gate Buy is behind
  // (RULING K3) — a winding-down market refuses new asks too, not just buys.
  if (m.windingDown) return false;
  if (!Number.isFinite(usd) || usd <= 0 || m.priceUsd <= 0) return false;
  const q = serviceQuote(usd, m.priceUsd);
  const held = m.position?.tokens ?? 0;
  if (!Number.isFinite(q.tokens) || q.tokens <= 0 || held < q.tokens) return false; // AskModal disables the CTA when unaffordable (H2)
  // Escrow the TOKEN LEG only (remove it from the position) and open an 'awaiting' ask.
  const next = reprice({ ...m, position: withPosition(m, held - q.tokens, m.position?.heldDays ?? 0) });
  markets.set(handle, next);
  askSeq += 1;
  asksList.unshift({
    id: `u${askSeq}`,
    handle,
    service: serviceName,
    state: 'awaiting',
    costUsd: usd,
    tokens: Math.round(q.tokens * 100) / 100,
    dueLabel: `Answer due in ${deadlineDays}d`,
    question: question.trim() || undefined
  });
  emit();
  return true;
}

export interface TokenMarketActions {
  market: TokenMarketDetail;
  /** Returns whether the buy actually executed — see buy()'s own doc; a refusal (wind-down, cap, slippage) must NOT be treated as success by the caller. */
  buy: (usdGross: number, maxTotalUsd?: number) => boolean;
  /** Returns whether the sell actually executed — see sell()'s own doc; a refusal (nothing held, sub-1-token) must NOT be treated as success by the caller. */
  sell: (tokens: number) => boolean;
  /** Returns whether the ask actually opened — see spend()'s own doc; a refusal (wind-down, unaffordable) must NOT be treated as success by the caller. */
  spend: (usd: number, serviceName?: string, deadlineDays?: number, question?: string) => boolean;
}

export function useTokenMarket(handle: string): TokenMarketActions {
  const market = useSyncExternalStore(
    subscribe,
    () => getMarket(handle),
    () => getMarketReadonly(handle)
  );
  return {
    market,
    buy: (usd, maxTotalUsd) => buy(handle, usd, maxTotalUsd),
    sell: (tokens) => sell(handle, tokens),
    spend: (usd, serviceName, deadlineDays, question) => spend(handle, usd, serviceName, deadlineDays, question)
  };
}

// ---- Derived list snapshots for the Discovery grid + Your-Tokens portfolio ----
// Rebuilt ONCE per mutation and returned as stable refs (useSyncExternalStore
// loops if getSnapshot returns a fresh array each call). This makes all three
// screens read one source of truth, so a buy/sell reflects everywhere.
const NEW_HANDLES = new Set(MOCK_NEW_CREATORS.map((c) => c.handle));
let summariesCache: CreatorTokenSummary[] = [];
let newSummariesCache: CreatorTokenSummary[] = [];
let holdingsCache: TokenHolding[] = [];

function deriveSummary(m: TokenMarketDetail): CreatorTokenSummary {
  const live = m.services.filter((s) => s.status === 'live').map((s) => s.usd);
  return {
    handle: m.handle,
    what: m.what,
    avatarColor: m.avatarColor,
    fromPriceUsd: live.length ? Math.min(...live) : 0,
    priceUsd: m.priceUsd,
    marketCapUsd: m.marketCapUsd,
    delivery: m.delivery,
    isNew: NEW_HANDLES.has(m.handle)
  };
}

function deriveHolding(m: TokenMarketDetail): TokenHolding {
  const p = m.position;
  return {
    handle: m.handle,
    what: m.what,
    avatarColor: m.avatarColor,
    tokens: p ? p.tokens : 0,
    valueUsd: p ? p.valueUsd : 0,
    floorValueUsd: p ? p.floorValueUsd : 0,
    priceUsd: m.priceUsd,
    changePctWeek: m.changePctWeek,
    spark: m.chart.slice(-6),
    windingDown: m.windingDown
  };
}

function rebuildCaches(): void {
  const all: CreatorTokenSummary[] = [];
  const news: CreatorTokenSummary[] = [];
  const holds: TokenHolding[] = [];
  for (const m of markets.values()) {
    if (m.handle === STUDIO_HANDLE) continue; // your own token lives in the Studio, not Discovery/Portfolio
    const s = deriveSummary(m);
    (s.isNew ? news : all).push(s);
    if (m.position && m.position.tokens > 0) holds.push(deriveHolding(m));
  }
  summariesCache = all;
  newSummariesCache = news;
  holdingsCache = holds;
}
rebuildCaches(); // initial snapshot from the seed

export function useCreatorList(): { creators: CreatorTokenSummary[]; newCreators: CreatorTokenSummary[] } {
  const creators = useSyncExternalStore(subscribe, () => summariesCache, () => summariesCache);
  const newCreators = useSyncExternalStore(subscribe, () => newSummariesCache, () => newSummariesCache);
  return { creators, newCreators };
}

export function useMyHoldings(): TokenHolding[] {
  return useSyncExternalStore(subscribe, () => holdingsCache, () => holdingsCache);
}

// Reclaim an ask once its window is open ('reclaimable') — returns the escrowed
// tokens to the holder's position and marks it 'reclaimed'. Never gated on billing
// (mirrors the contract's "outflows never pause"). Refuses in any other state
// (not found, or not yet/no-longer reclaimable) rather than silently no-op'ing —
// the caller must not treat a refusal as tokens having come back.
export function reclaimAsk(id: string): boolean {
  const a = asksList.find((x) => x.id === id);
  if (!a || a.state !== 'reclaimable') return false;
  a.state = 'reclaimed';
  // Only credit the viewer's OWN position for an OUTGOING ask (to another creator).
  // An incoming ask's escrow belongs to a different buyer, not the viewer — never
  // credit it back to the viewer's own-token position (#8).
  const m = markets.get(a.handle);
  if (m && a.handle !== STUDIO_HANDLE) {
    const held = (m.position?.tokens ?? 0) + a.tokens;
    markets.set(a.handle, reprice({ ...m, position: withPosition(m, held, m.position?.heldDays ?? 0) }));
  }
  emit();
  return true;
}

export function useMyAsks(): PortfolioAsk[] {
  return useSyncExternalStore(subscribe, () => outgoingAsksSnapshot, () => outgoingAsksSnapshot);
}

// ---- Follow a creator (Lumen-local; the token-page Follow button) ----
const creatorFollows = new Set<string>();
export function toggleCreatorFollow(handle: string): void {
  if (creatorFollows.has(handle)) creatorFollows.delete(handle);
  else creatorFollows.add(handle);
  emit();
}
export function useIsFollowingCreator(handle: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => creatorFollows.has(handle),
    () => creatorFollows.has(handle)
  );
}

// ---- Transfer your own tokens to another user (Lumen-local; recipient is
// display-only in the mock — this just debits the sender's position). ----
// Returns whether the transfer actually executed. A request for more than the
// sender holds is a REFUSAL, not a silent clamp to "send everything you have" —
// the old `Math.min(tokens, held)` shape sent less than the user typed and
// reported it as done, the same class of lie buy()/sell() were fixed for.
export function transferTokens(handle: string, tokens: number): boolean {
  const m = markets.get(handle);
  if (!m) return false; // no market for this handle
  if (!Number.isFinite(tokens) || tokens <= 0) return false; // invalid amount
  const held = m.position?.tokens ?? 0;
  if (tokens > held) return false; // insufficient balance — never silently send less than requested
  markets.set(handle, reprice({ ...m, position: withPosition(m, held - tokens, m.position?.heldDays ?? 0) }));
  emit();
  return true;
}

// ---- Retire your own token: winds the market down (Buy stops, Sell/reclaim stay
// open — the windingDown read-side was already built; this is the missing writer). ----
// Returns whether it actually wound the market down — false if there is no
// own-token market yet, or it is already winding down (nothing left to do).
export function retireOwnToken(): boolean {
  const m = markets.get(STUDIO_HANDLE);
  if (!m || m.windingDown) return false;
  markets.set(STUDIO_HANDLE, { ...m, windingDown: true });
  emit();
  return true;
}

// ------------------------------ Creator Studio -------------------------------
// The viewer's OWN creator token. Kept in the same store so the studio's market,
// inbox and earnings are the same source of truth as the rest of the feature.
if (!markets.has(STUDIO_HANDLE)) {
  markets.set(STUDIO_HANDLE, {
    ...defaultDetail(STUDIO_HANDLE),
    what: 'Your creator token',
    avatarColor: 'linear-gradient(135deg,#c0392b,#e07b3e)',
    reputation: 68,
    // FRESH, un-launched token (#3/#11): the wizard mints the first supply. A live
    // pre-seed made the wizard a "relaunch" whose cap collided with the seeded supply.
    priceUsd: 1,
    marketCapUsd: 0,
    floorUsd: 0,
    supply: 0,
    cap: 20000,
    reserveUsd: 0,
    chart: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    delivery: { answered: 0, total: 0, completionPct: 0, typicalResponse: '', marks: [], available: false },
    services: [
      { key: 'ask', name: 'Ask a question', desc: 'One private question, answered within your deadline — or your tokens back.', usd: 10, status: 'live', cta: 'Ask' },
      { key: 'review', name: 'Review my work', desc: 'A written review of a repo, doc or plan.', usd: 80, status: 'live', cta: 'Request' }
    ],
    position: null
  });
}

// Incoming asks addressed TO you (the studio Inbox), prepended to the viewer's own.
asksList = [
  { id: 'in1', handle: STUDIO_HANDLE, service: 'Ask a question', state: 'awaiting', costUsd: 10, tokens: 2.38, dueLabel: 'Answer due in 20h', urgent: true },
  { id: 'in2', handle: STUDIO_HANDLE, service: 'Review my work', state: 'awaiting', costUsd: 80, tokens: 19.0, dueLabel: 'Answer due in 3d' },
  ...asksList
];
asksSnapshot = asksList.slice();
outgoingAsksSnapshot = asksList.filter((a) => a.handle !== STUDIO_HANDLE);

export interface StudioState {
  market: TokenMarketDetail;
  inbox: PortfolioAsk[];
  subDaysLeft: number;
  tradeFeeClaimableUsd: number;
  commissionEarnedUsd: number;
  launched: boolean;
}

/**
 * Answer an incoming ask → 'answered'; books its commission to earnings.
 * Returns whether it actually answered — false if the ask no longer exists or
 * is no longer 'awaiting' (already answered/reclaimed/expired), so the modal
 * must not tell the creator they got paid when they didn't.
 */
export function answerAsk(id: string, answer = 'Answered.'): boolean {
  const a = asksList.find((x) => x.id === id);
  if (!a || a.state !== 'awaiting') return false;
  a.state = 'answered';
  a.answer = answer;
  commissionEarnedUsd += Math.round(a.costUsd * 0.88 * 100) / 100; // creator keeps 88% (12% commission)
  emit();
  return true;
}

/**
 * Renew the listing by `months` (~$10/mo). Returns whether it actually
 * renewed — false on an invalid length, so a bad value can never silently
 * corrupt subDaysLeft to NaN (Math.max(1, NaN) is itself NaN).
 */
export function renewSubscription(months = 1): boolean {
  if (!Number.isFinite(months) || months <= 0) return false;
  subDaysLeft += Math.max(1, Math.round(months)) * 30;
  emit();
  return true;
}

/**
 * Edit one of your live service prices (USD). Returns whether it actually
 * changed — false on an invalid price, no own-token market yet, or a `key`
 * that matches none of your services (the old shape ran `.map` regardless and
 * reported success even when nothing matched and nothing changed).
 */
export function setServicePrice(key: string, usd: number): boolean {
  if (!Number.isFinite(usd) || usd <= 0) return false;
  const price = Math.min(Math.round(usd * 100) / 100, 1_000_000); // #4: round + bound
  const m = markets.get(STUDIO_HANDLE);
  if (!m) return false;
  if (!m.services.some((s) => s.key === key)) return false; // unknown service key — nothing to update
  const services = m.services.map((s) => (s.key === key ? { ...s, usd: price } : s));
  markets.set(STUDIO_HANDLE, { ...m, services });
  emit();
  return true;
}

/**
 * Raise your supply cap (lower only down to what's issued). Returns whether
 * it actually raised — false on no own-token market, an invalid value, or a
 * value below what's already issued.
 */
export function raiseCap(newCap: number): boolean {
  const m = markets.get(STUDIO_HANDLE);
  if (!m || !Number.isFinite(newCap)) return false;
  const issued = Math.ceil(m.supply);
  // #3: reject a value below what's already issued instead of silently clamping to
  // supply (which would set cap == supply and soft-lock every future buy). #7: bound it.
  if (newCap < issued) return false;
  markets.set(STUDIO_HANDLE, { ...m, cap: Math.min(newCap, 1_000_000_000) });
  emit();
  return true;
}

/**
 * Claim your accrued 5% trade-fee share. Returns whether there was anything
 * to claim — false when the claimable balance is already 0, so a claim can
 * never be reported as settled twice.
 */
export function claimTradeFees(): boolean {
  if (tradeFeeClaimableUsd <= 0) return false;
  tradeFeeClaimableUsd = 0;
  emit();
  return true;
}

export interface LaunchResult {
  /** Whether the launch itself completed (services + cap applied, `launched` flag set). False only when there is no own-token market to launch into — unreachable in practice, since the studio token is seeded at module load, but checked rather than assumed. */
  launched: boolean;
  /**
   * True when `firstBuyUsd` was requested but the optional anti-snipe first
   * buy could NOT be filled — the budget was too small to afford one whole
   * token, or it would have pushed supply past the cap. THE DEFECT THIS
   * CLOSES: the launch used to report success unconditionally even when this
   * happened, silently dropping the creator's first buy while telling them
   * the wizard finished — the same lie one level deeper than a refused
   * buy()/sell(). The launch itself still completes either way; only the
   * first buy silently did nothing, and now the caller can say so.
   */
  firstBuySkipped: boolean;
}

/**
 * Launch/configure your token from the wizard: set services + cap, apply the
 * OPTIONAL anti-snipe first-buy (full curve cost, no premine), mark it launched.
 */
export function launchToken(input: { services?: Service[]; cap?: number; firstBuyUsd?: number }): LaunchResult {
  const m = markets.get(STUDIO_HANDLE);
  if (!m) return { launched: false, firstBuySkipped: false };
  const next: TokenMarketDetail = { ...m };
  if (input.services && input.services.length) {
    // #5: round + bound each price; drop invalid; keep existing if all invalid.
    const cleaned = input.services
      .map((s) => ({ ...s, usd: Math.min(Math.round((Number.isFinite(s.usd) ? s.usd : 0) * 100) / 100, 1_000_000) }))
      .filter((s) => s.usd > 0);
    if (cleaned.length) next.services = cleaned;
  }
  if (input.cap && Number.isFinite(input.cap)) {
    next.cap = Math.min(Math.max(Math.floor(input.cap), Math.ceil(next.supply)), 1_000_000_000); // #5 bound
  }
  const spend =
    input.firstBuyUsd && input.firstBuyUsd > 0 && Number.isFinite(input.firstBuyUsd) ? Math.min(input.firstBuyUsd, 1_000_000) : 0;
  // Only true when a first buy was REQUESTED (spend > 0) but could not be filled —
  // requesting none at all is not a skip, it's simply not asking for one.
  let firstBuySkipped = false;
  if (spend > 0) {
    const q = buyQuote(spend, next);
    // #2: never let the first-buy push supply past the cap. Whole tokens only.
    if (Number.isFinite(q.tokens) && q.tokens >= 1 && Math.floor(next.supply) + q.tokens <= next.cap) {
      const oldTokens = next.position?.tokens ?? 0;
      const total = oldTokens + q.tokens;
      const heldDays = total > 0 ? Math.round((oldTokens * (next.position?.heldDays ?? 0)) / total) : 0; // #6 weighted
      next.supply = Math.floor(next.supply) + q.tokens;
      next.priceUsd = Math.max(0.01, Math.round(q.priceAfter * 100) / 100);
      // Curve leg only (the ACTUAL cost, not the requested budget — integer
      // tokens mean the two differ) so R === Area(S) still holds.
      next.reserveUsd += q.totalUsd - q.tradeFeeUsd;
      next.position = { valueUsd: 0, floorValueUsd: 0, ...(next.position ?? {}), tokens: total, heldDays };
    } else {
      // The budget bought less than one whole token, or would have breached the
      // cap — the OLD code silently dropped the buy here and still reported the
      // whole launch as a plain success. It doesn't any more; the caller decides
      // how to tell the creator their first buy vanished.
      firstBuySkipped = true;
    }
  }
  markets.set(STUDIO_HANDLE, reprice(next));
  launched = true;
  subDaysLeft = 30; // first month included
  emit();
  return { launched: true, firstBuySkipped };
}

export function useStudio(): StudioState {
  return useSyncExternalStore(
    subscribe,
    () => buildStudio(),
    () => buildStudio()
  );
}

// Re-init the snapshot now that the own-token + inbox are seeded above.
studioSnapshot = buildStudioRaw();
function buildStudioRaw(): StudioState {
  return {
    market: getMarketReadonly(STUDIO_HANDLE),
    inbox: asksList.filter((a) => a.handle === STUDIO_HANDLE && a.state === 'awaiting'),
    subDaysLeft,
    tradeFeeClaimableUsd,
    commissionEarnedUsd,
    launched
  };
}
function buildStudio(): StudioState {
  return studioSnapshot;
}
