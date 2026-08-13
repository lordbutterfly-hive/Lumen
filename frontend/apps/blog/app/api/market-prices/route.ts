import { NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { cachedRead } from '@/blog/lib/server-read-cache';

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
export async function GET(): Promise<NextResponse> {
  try {
    const data = await cachedRead('market-prices', CACHE_MS, async () => {
      const init = { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS), cache: 'no-store' as const };
      const [simpleRes, chartRes] = await Promise.all([
        fetch(
          `${COINGECKO_BASE}/simple/price?ids=hive,hive_dollar&vs_currencies=usd,btc&include_24hr_change=true`,
          init
        ),
        fetch(`${COINGECKO_BASE}/coins/hive/market_chart?vs_currency=usd&days=7`, init)
      ]);
      if (!simpleRes.ok || !chartRes.ok) {
        throw new Error(`coingecko request failed: ${simpleRes.status}/${chartRes.status}`);
      }
      return { simple: await simpleRes.json(), chart: await chartRes.json() };
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
