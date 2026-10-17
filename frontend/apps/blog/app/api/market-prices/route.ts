import { NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { cachedRead } from '@/blog/lib/server-read-cache';
import { withRetry } from '@transaction/lib/retry';
import { getChain } from '@transaction/lib/chain';
import { withHiveRetry } from '@smart-signer/lib/hive-network-error';

const logger = getLogger('app');

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
const UPSTREAM_TIMEOUT_MS = 8_000;

/** A spot price is the same number for every reader, and CoinGecko's free tier is
 *  rate-limited per IP. 60s is well inside what a price card needs and turns N
 *  readers into one upstream call a minute. */
const CACHE_MS = 60_000;

/**
 * GET /api/market-prices — HIVE/HBD spot prices + the 7-day series, server-side.
 *
 * ★ WHY THIS EXISTS (measured 2026-08-13). `use-hive-market-prices.ts` called
 * `api.coingecko.com` DIRECTLY FROM THE BROWSER, twice per wallet load, at ~250ms
 * each. Three things wrong with that, none of them theoretical:
 *
 *   1. The rate limit is charged to THE READER'S IP on a free public tier. Enough
 *      readers behind one NAT — an office, a campus, a mobile carrier — and the
 *      price card starts failing for all of them, with nothing we can do about it.
 *   2. Every reader's IP and browsing time is handed to a third party on a page
 *      they visited to look at their own wallet.
 *   3. Nothing could cache it. Each reader paid the full round trip, every load.
 *
 * Server-side, one call serves everyone for CACHE_MS. The hook's contract is
 * unchanged — same two upstream shapes, fetched in parallel, same JSON handed
 * back — so its careful handling of a 200-with-missing-price (never coerce a
 * missing number to 0, because a $0 HIVE renders a fabricated account value)
 * stays exactly where it is, in the hook.
 *
 * Cached `public`: this is a public market price with no per-viewer component.
 */
/**
 * ★ A6 retry rollout (2026-08-18): each leg retried independently so a blip on
 * one does not force re-fetching the other, which already succeeded. Throws an
 * error carrying `.status` on a non-ok response so `isTransient` can see the
 * 5xx (a 4xx from CoinGecko — e.g. a bad ids param, which never happens here
 * with fixed query strings — is correctly left un-retried).
 */
async function fetchCoingecko(url: string, label: string, init: RequestInit): Promise<unknown> {
  return withRetry(
    async () => {
      const res = await fetch(url, init);
      if (!res.ok) {
        const error = new Error(`${label} request failed: ${res.status}`) as Error & { status?: number };
        error.status = res.status;
        throw error;
      }
      return res.json();
    },
    { label }
  );
}

/**
 * ★ HBD IS VALUED ON HIVE'S OWN MARKET, NOT ON COINGECKO (2026-10-17).
 * CoinGecko's HBD price comes from outside exchanges, and on 2026-10-17 every
 * ticker it had was Upbit (HBD/BTC, $2.92 while HIVE/HBD on the internal market
 * put HBD at $0.97). Upbit had flagged HBD for possible delisting and halted
 * deposits and withdrawals the day before, so nobody could arbitrage it back,
 * and every HBD balance on the wallet was valued at about 3x. The internal
 * market is where an HBD holder can actually sell, so its last trade is the
 * price (`latest`, in HBD per HIVE). Its own leg: a failed ticker returns null
 * and the hook falls back to CoinGecko rather than failing the price cards.
 */
async function fetchInternalMarketTicker(): Promise<{ latest: string } | null> {
  try {
    const ticker = await withHiveRetry(
      async () => (await getChain()).api.market_history_api.get_ticker({}),
      'market_history_api.get_ticker'
    );
    return { latest: ticker.latest };
  } catch (error) {
    logger.warn(error, 'internal market ticker lookup failed');
    return null;
  }
}

export async function GET(): Promise<NextResponse> {
  try {
    const data = await cachedRead('market-prices', CACHE_MS, async () => {
      const init = { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS), cache: 'no-store' as const };
      const [simple, chart, internal] = await Promise.all([
        fetchCoingecko(
          // `bitcoin` added 2026-09-08 for the wallet's Magi tab (BTC held on Magi is priced
          // off the same feed as HIVE/HBD); the hook keeps its "never coerce to 0" rule.
          `${COINGECKO_BASE}/simple/price?ids=hive,hive_dollar,bitcoin&vs_currencies=usd,btc&include_24hr_change=true`,
          'coingecko.simple',
          init
        ),
        fetchCoingecko(`${COINGECKO_BASE}/coins/hive/market_chart?vs_currency=usd&days=7`, 'coingecko.chart', init),
        fetchInternalMarketTicker()
      ]);
      return { simple, chart, internal };
    });
    return NextResponse.json(data, {
      headers: { 'cache-control': 'public, max-age=60, stale-while-revalidate=300' }
    });
  } catch (error) {
    // The hook already renders a labelled "price unavailable" placeholder rather
    // than a stale or invented number, so a failure here degrades exactly as the
    // direct call did — it just no longer costs the reader their own rate limit.
    logger.error(error, 'market prices lookup failed');
    return NextResponse.json({ error: 'market_prices_unavailable' }, { status: 502 });
  }
}
