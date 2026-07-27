'use client';

import { useSyncExternalStore } from 'react';
import type { CreatorTokenSummary } from './types';
import type { TokenHolding, PortfolioAsk } from './portfolio';
import type { TokenMarketDetail, HolderPosition, Service } from './token-detail';
import { MOCK_TOKEN_DETAIL } from './token-detail';
import { MOCK_CREATORS, MOCK_NEW_CREATORS } from './mock';
import { MOCK_HOLDINGS, MOCK_ASKS } from './portfolio';
import { buyQuote, sellQuote, serviceTokens, spotPriceUsd, reserveUsdAt } from './curve';

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

// Seed: @ada from the richest fixture, the rest synthesized from the summaries.
const markets = new Map<string, TokenMarketDetail>();
markets.set(MOCK_TOKEN_DETAIL.handle, { ...MOCK_TOKEN_DETAIL });
for (const c of [...MOCK_CREATORS, ...MOCK_NEW_CREATORS]) {
  if (!markets.has(c.handle)) markets.set(c.handle, synthDetail(c));
}
// Seed the viewer's starting portfolio so Your-Tokens is populated up front and
// then tracks live trades (a buy adds/increases a position, a sell reduces it).
for (const h of MOCK_HOLDINGS) {
  const m = markets.get(h.handle);
  if (m) {
    m.position = { tokens: h.tokens, valueUsd: h.valueUsd, floorValueUsd: h.floorValueUsd, heldDays: 30 };
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
    floorValueUsd: round2(tokens * m.floorUsd),
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
 * that budget).
 *
 * ★ INTEGER TOKENS (curve pivot): the curve mints whole tokens only, so the
 * budget buys the largest whole count that fits and the ACTUAL cost
 * (`q.totalUsd`) is at most the budget. The reserve is credited the curve leg
 * alone — crediting the fee too would break the R === Area(S) equality that
 * the whole mechanism rests on (buy.go: "booking the fee into the reserve
 * would break R === area(S)").
 */
export function buy(handle: string, usdGross: number): void {
  if (handle === STUDIO_HANDLE) return; // #2: you can't buy your own token — no self-dealing
  const m = getMarket(handle);
  if (!Number.isFinite(usdGross) || usdGross <= 0) return;
  usdGross = Math.min(usdGross, 1_000_000); // ceiling — a fat-finger 1e999 must not poison the market to NaN (H1)
  const q = buyQuote(usdGross, m);
  if (!Number.isFinite(q.tokens) || q.tokens < 1) return; // a budget that can't afford one whole token buys nothing
  const supply = Math.floor(m.supply) + q.tokens;
  if (supply > m.cap) return; // #4: never let supply exceed the cap
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
 */
export function sell(handle: string, tokens: number): void {
  const m = getMarket(handle);
  if (!Number.isFinite(tokens)) return;
  const held = m.position?.tokens ?? 0;
  const n = Math.floor(Math.min(tokens, held, Math.floor(m.supply)));
  if (n <= 0) return;
  const q = sellQuote(n, m, m.position?.heldDays ?? 999);
  if (q.curveProceedsUsd <= 0) return;
  const supply = Math.max(0, Math.floor(m.supply) - n);
  const priceUsd = Math.max(0.01, round2(supply > 0 ? spotPriceUsd(supply) : m.floorUsd));
  const reserveUsd = Math.max(0, m.reserveUsd - q.curveProceedsUsd);
  const next = reprice({ ...m, supply, priceUsd, reserveUsd, position: withPosition({ ...m, priceUsd }, held - n, m.position?.heldDays ?? 0) });
  markets.set(handle, next);
  emit();
}

/** Spend tokens on a USD-priced service (tokens = USD ÷ live price). */
export function spend(handle: string, usd: number, serviceName = 'Ask a question', deadlineDays = 7, question = ''): void {
  if (handle === STUDIO_HANDLE) return; // #2: can't ask your own token (would let you answer yourself for commission)
  const m = getMarket(handle);
  if (!Number.isFinite(usd) || usd <= 0 || m.priceUsd <= 0) return;
  const tokensSpent = serviceTokens(usd, m.priceUsd);
  const held = m.position?.tokens ?? 0;
  if (!Number.isFinite(tokensSpent) || held < tokensSpent) return; // AskModal disables the CTA when unaffordable (H2)
  // Escrow the tokens (remove them from the position) and open an 'awaiting' ask.
  const next = reprice({ ...m, position: withPosition(m, held - tokensSpent, m.position?.heldDays ?? 0) });
  markets.set(handle, next);
  askSeq += 1;
  asksList.unshift({
    id: `u${askSeq}`,
    handle,
    service: serviceName,
    state: 'awaiting',
    costUsd: usd,
    tokens: Math.round(tokensSpent * 100) / 100,
    dueLabel: `Answer due in ${deadlineDays}d`,
    question: question.trim() || undefined
  });
  emit();
}

export interface TokenMarketActions {
  market: TokenMarketDetail;
  buy: (usdGross: number) => void;
  sell: (tokens: number) => void;
  spend: (usd: number, serviceName?: string, deadlineDays?: number, question?: string) => void;
}

export function useTokenMarket(handle: string): TokenMarketActions {
  const market = useSyncExternalStore(
    subscribe,
    () => getMarket(handle),
    () => getMarketReadonly(handle)
  );
  return {
    market,
    buy: (usd) => buy(handle, usd),
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
// (mirrors the contract's "outflows never pause"). No-op in any other state.
export function reclaimAsk(id: string): void {
  const a = asksList.find((x) => x.id === id);
  if (!a || a.state !== 'reclaimable') return;
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
export function transferTokens(handle: string, tokens: number): void {
  const m = markets.get(handle);
  if (!m || !Number.isFinite(tokens) || tokens <= 0) return;
  const held = m.position?.tokens ?? 0;
  const n = Math.min(tokens, held);
  if (n <= 0) return;
  markets.set(handle, reprice({ ...m, position: withPosition(m, held - n, m.position?.heldDays ?? 0) }));
  emit();
}

// ---- Retire your own token: winds the market down (Buy stops, Sell/reclaim stay
// open — the windingDown read-side was already built; this is the missing writer). ----
export function retireOwnToken(): void {
  const m = markets.get(STUDIO_HANDLE);
  if (!m) return;
  markets.set(STUDIO_HANDLE, { ...m, windingDown: true });
  emit();
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

/** Answer an incoming ask → 'answered'; books its commission to earnings. */
export function answerAsk(id: string, answer = 'Answered.'): void {
  const a = asksList.find((x) => x.id === id);
  if (!a || a.state !== 'awaiting') return;
  a.state = 'answered';
  a.answer = answer;
  commissionEarnedUsd += Math.round(a.costUsd * 0.88 * 100) / 100; // creator keeps 88% (12% commission)
  emit();
}

/** Renew the listing by `months` (~$10/mo). */
export function renewSubscription(months = 1): void {
  subDaysLeft += Math.max(1, Math.round(months)) * 30;
  emit();
}

/** Edit one of your live service prices (USD). */
export function setServicePrice(key: string, usd: number): void {
  if (!Number.isFinite(usd) || usd <= 0) return;
  const price = Math.min(Math.round(usd * 100) / 100, 1_000_000); // #4: round + bound
  const m = markets.get(STUDIO_HANDLE);
  if (!m) return;
  const services = m.services.map((s) => (s.key === key ? { ...s, usd: price } : s));
  markets.set(STUDIO_HANDLE, { ...m, services });
  emit();
}

/** Raise your supply cap (lower only down to what's issued). */
export function raiseCap(newCap: number): void {
  const m = markets.get(STUDIO_HANDLE);
  if (!m || !Number.isFinite(newCap)) return;
  const issued = Math.ceil(m.supply);
  // #3: reject a value below what's already issued instead of silently clamping to
  // supply (which would set cap == supply and soft-lock every future buy). #7: bound it.
  if (newCap < issued) return;
  markets.set(STUDIO_HANDLE, { ...m, cap: Math.min(newCap, 1_000_000_000) });
  emit();
}

/** Claim your accrued 5% trade-fee share. */
export function claimTradeFees(): void {
  tradeFeeClaimableUsd = 0;
  emit();
}

/**
 * Launch/configure your token from the wizard: set services + cap, apply the
 * OPTIONAL anti-snipe first-buy (full curve cost, no premine), mark it launched.
 */
export function launchToken(input: { services?: Service[]; cap?: number; firstBuyUsd?: number }): void {
  const m = markets.get(STUDIO_HANDLE);
  if (!m) return;
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
    }
  }
  markets.set(STUDIO_HANDLE, reprice(next));
  launched = true;
  subDaysLeft = 30; // first month included
  emit();
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
