import 'server-only';
import { getLogger } from '@ui/lib/logging';
import { withTtlCache } from '@/blog/lib/server-ttl-cache';
import { consumeLocalGlobal } from '@/blog/lib/lite/antispam/local-rate-limit';
import { STATE_QUERY, kRegisteredAt, kSupply, kUnitsMarket, toDid, toU64, tokenCountFromState } from '@/blog/features/creator-tokens/lib/vsc/reads';
import { displayPriceUsd } from '@/blog/features/creator-tokens/market/curve';

const logger = getLogger('app');

/**
 * ★ THE SERVER'S OWN READ OF A MARKET — for the two things a Meritum creator
 * page must know BEFORE any JavaScript runs (handoff §0/§4, 2026-09-15): does
 * this creator have a market at all (a 404 otherwise, never an empty page),
 * and what is the price right now (the share card carries it, and a crawler
 * that scrapes the card never runs the client).
 *
 * The browser reads the chain through `/api/creator-tokens/gql`, a same-origin
 * proxy (see that route). A server component cannot fetch a relative path, so
 * this posts the SAME allowlisted query straight to the upstream the proxy
 * itself forwards to, from the same env var, with the same two facts derived
 * the same way `readMarketPricesBatch` (lib/vsc-data-source.ts) derives them:
 * `kRegisteredAt == 0` means never registered (market.go's own convention),
 * and the price is `displayPriceUsd(supply)` — the curve, never a quote.
 *
 * Deliberately NOT the full `readMarket`: phase, delinquency, rules and the
 * head block are the page's business and the client hook already owns them.
 * Two keys, one request, cached 30 s per creator so a burst of crawlers (a
 * share fans out to a dozen unfurlers at once) costs the node one read.
 *
 * ★ UNDER THE SAME GLOBAL CEILING AS THE PROXY (review, 2026-09-15). The
 * browser's reads pass `consumeLocalGlobal('creator_tokens_gql')` in
 * `/api/creator-tokens/gql` — the one bound on how much this server can
 * amplify against the Magi node in total, which per-IP limits cannot give.
 * A server-side read that skipped it would re-open exactly that hole, one
 * distinct handle per request. Over the ceiling this returns null, which the
 * page treats as "could not read" (renders, no 404) and the card as "no
 * price line" — never as a fact about the market.
 *
 * ★ ITS OWN BOUNDED CACHE, NOT `cachedRead` (review, 2026-09-15): that memo
 * is one 500-entry map shared with `/api/account`; a crawl of a few hundred
 * creator pages would have flushed the account cache the feed depends on.
 */
export interface CreatorMarketSummary {
  /** `hive:<name>` or the DID — what the chain keys the market under. */
  did: string;
  registered: boolean;
  supply: number;
  priceUsd: number;
}

const SUMMARY_TTL_MS = 30_000;
const UPSTREAM_TIMEOUT_MS = 5_000;

function upstream(): { url: string; contractId: string } | null {
  const url = process.env.REACT_APP_CREATOR_TOKENS_GQL_URL;
  const contractId = process.env.REACT_APP_CREATOR_TOKENS_CONTRACT_ID;
  if (!url || !contractId) return null;
  return { url, contractId };
}

async function fetchSummary(handle: string): Promise<CreatorMarketSummary | null> {
  const target = upstream();
  if (!target) return null;
  const did = toDid(handle);
  const keys = [kRegisteredAt(did), kSupply(did), kUnitsMarket(did)];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(target.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: STATE_QUERY, variables: { contractId: target.contractId, keys } }),
      signal: controller.signal,
      cache: 'no-store'
    });
    if (!res.ok) throw new Error(`upstream HTTP ${res.status}`);
    const json = (await res.json()) as { data?: { getStateByKeys?: Record<string, unknown> }; errors?: unknown[] };
    if (Array.isArray(json.errors) && json.errors.length > 0) throw new Error(`upstream: ${JSON.stringify(json.errors[0]).slice(0, 200)}`);
    const map = json.data?.getStateByKeys ?? {};
    const raw = (key: string): string | null => {
      const v = map[key];
      return typeof v === 'string' ? v : null;
    };
    const registeredAt = toU64(raw(kRegisteredAt(did)));
    const supply = tokenCountFromState(raw(kSupply(did)), raw(kUnitsMarket(did))); // v6: units once migrated, whole tokens before
    const registered = registeredAt > 0;
    return {
      did,
      registered,
      supply: registered && Number.isFinite(supply) && supply >= 0 ? supply : 0,
      priceUsd: registered ? displayPriceUsd(Number.isFinite(supply) && supply >= 0 ? supply : 0) : 0
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Null means "could not read" — the caller must NOT turn that into a 404: a
 * node outage is not a creator without a market. A summary with
 * `registered: false` is the honest 404.
 */
const readSummaryCached = withTtlCache(
  async (handle: string): Promise<CreatorMarketSummary | null> => {
    if (!consumeLocalGlobal('creator_tokens_gql')) {
      logger.warn('meritum page: market summary read shed — global Magi ceiling hit');
      return null;
    }
    return fetchSummary(handle);
  },
  (handle: string) => toDid(handle),
  { name: 'meritum-market-summary', ttlMs: SUMMARY_TTL_MS, max: 500, shouldCache: (v) => v !== null }
);

export async function readCreatorMarketSummary(handle: string): Promise<CreatorMarketSummary | null> {
  try {
    return await readSummaryCached(handle);
  } catch (error) {
    logger.warn(error, 'meritum page: market summary read failed for %s', handle);
    return null;
  }
}
