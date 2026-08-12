import { NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { getTrendingTags } from '@transaction/lib/hive';

const logger = getLogger('app');

/**
 * ★★★ WHY THIS ROUTE EXISTS: IT IS WHY EVERY VISITOR DOWNLOADED 2.34 MB OF WASM.
 *
 * `features/layouts/right-rail/topics.tsx` is a `'use client'` widget mounted on
 * most page shells (home, topics, profile, wallet, witnesses, proposals). It
 * called `getTrendingTags` directly, and that function does `await getChain()` —
 * so `@hiveio/wax` landed in the CLIENT graph of nearly every route.
 *
 * `@hiveio/wax` ships a single entry point (`wasm/dist/bundle/web.js`), so one
 * non-`type` import anywhere in a client path drags the whole ~2.3 MB bundle,
 * WASM included. Measured against the production build, in a real browser, as
 * an anonymous visitor who will never sign anything: `wax.common.wasm`
 * **2.34 MB actually fetched** on the home page and on a post permalink, inside
 * a 6.36 MB total page weight.
 *
 * A separate pass had already lazy-loaded the SIGNING machinery
 * (`packages/transaction/index.ts`, `SignerProvider`, the OAuth continuation),
 * which closed every path from the root layout. This decorative sidebar READ
 * was the one that kept the bundle alive for `/page` anyway. Signing was never
 * the trigger.
 *
 * The fix is the pattern this codebase already used twice for exactly this
 * problem — `/api/discussion` and `/api/account-posts`: keep the chain call on
 * the server and hand the browser plain JSON.
 *
 * ★ CACHED, and safe to cache. Trending tags are GLOBAL, identical for every
 * visitor, and carry nothing personalised — the opposite of the recsys feed,
 * which is deliberately `no-store` because it is per-viewer. Caching also takes
 * this widget off the chain entirely for most requests: it previously issued a
 * `condenser_api.get_trending_tags` call per reader per page shell.
 */
/**
 * ★ CACHE HARD, AND STAY SERVING WHEN THE CHAIN IS DOWN (owner ruling, 2026-08-12).
 *
 * "that should just rotate every 10-20 mins... even if it rotated once a day it
 * would be fine. its just a topic list, and those topics are generally always
 * the same."
 *
 * Correct, and it makes this strictly better in three ways at once. An hour of
 * freshness is far more than a slow-moving global tag list needs, and it takes
 * the chain call from once-per-reader-per-page-shell to roughly 24 times a day
 * for the whole site.
 *
 * `stale-while-revalidate` is the part that matters most, though. With a day of
 * staleness allowed, a Hive node that is slow, rate-limiting or outright down
 * no longer empties this card — the last known list keeps being served while a
 * refresh is attempted behind it. That is the direct cure for the audit's
 * "right rail Topics renders as grey pill skeletons for 20s+ and on several
 * loads never resolved" (item O3): every reader used to wait on their own
 * uncached `condenser_api.get_trending_tags`, so one unhealthy node meant grey
 * pills for everybody.
 *
 * Nothing here is personalised, so there is no correctness cost to a long TTL —
 * this is the exact opposite case from the recsys feed, which is deliberately
 * `no-store` because it is per-viewer.
 */
export const revalidate = 3600;

/** What the widget asks for. Deliberately fixed rather than a query parameter:
 *  the only caller wants this exact number, and a browser-controlled limit
 *  would be a free way to make us hammer the chain with large requests. The
 *  widget over-fetches on purpose (community ids and tribe tags occupy most of
 *  the head of the list, so a request for 12 yielded 0 usable topics). */
const TAG_LIMIT = 120;

export async function GET(): Promise<NextResponse> {
  try {
    const tags = await getTrendingTags(TAG_LIMIT);
    return NextResponse.json(
      { tags },
      { headers: { 'cache-control': 'public, s-maxage=3600, stale-while-revalidate=86400' } }
    );
  } catch (error) {
    logger.error(error, 'trending tags lookup failed');
    // ★ A REAL STATUS, NOT AN EMPTY 200. An empty list would render as "no
    // topics" — indistinguishable from a chain that answered and had nothing to
    // say. This codebase has been bitten by that exact shape more than once
    // (a feed wiped by a 200-with-no-entries, a mute list that read a timeout as
    // "you mute nobody"), so a failure says so and the widget shows its own
    // honest "Couldn't load trending topics." state.
    return NextResponse.json({ error: 'trending_tags_unavailable' }, { status: 502 });
  }
}
