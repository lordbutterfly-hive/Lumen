import { cache } from 'react';
import { getAccountFull, getAccountReputations, getDynamicGlobalProperties } from '@transaction/lib/hive-api';
import { getPost } from '@transaction/lib/bridge-api';
import { withTtlCache } from '@/blog/lib/server-ttl-cache';

/**
 * ★★★ THE PROFILE PAGE'S TTFB IS ONE UPSTREAM CALL (measured 2026-08-15).
 *
 * `/@<account>` was the slowest server route in the app: 407ms warm TTFB, ~92%
 * of it server-side. Timed directly from this box, `database_api.find_accounts`
 * against api.hive.blog answers in **357-366ms** across repeated attempts — so
 * roughly 88% of that TTFB is a single unavoidable round trip, not app code.
 * Nothing local optimises into that number; the only lever is not making the
 * call.
 *
 * `cache()` alone could not help: React's `cache()` is REQUEST-scoped, so it
 * deduplicates `generateMetadata` against the layout within one render and then
 * discards the result. The next view of the same profile pays the full 360ms
 * again — every reader, every visit, every tab.
 *
 * So there is a 30s cross-request layer underneath, and `cache()` stays on top
 * for the intra-request dedup it was already doing. 30 seconds because what this
 * feeds is a profile header — reputation, follower and post counts, JSON
 * metadata — none of it transactional, all of it fine a few seconds stale.
 *
 * The failure semantics matter more than the speed and live in
 * `server-ttl-cache.ts`: a rejection or a nameless result is NEVER stored, so
 * the 429 that once 404'd /@blocktrades cannot become a sticky 404.
 *
 * ★ SCOPE, DELIBERATELY NARROW. Only the profile layout imports
 * `getAccountFullCached`. The wallet calls `getAccountFull` directly and stays
 * that way — a 30-second-stale BALANCE is a much worse bug than a slow page.
 */
const accountFullTtl = withTtlCache(getAccountFull, (username: string) => username, {
  ttlMs: 30_000,
  max: 500,
  /*
   * ★ THE ABSENCE IS CACHED TOO, AND THAT IS THE LITE READER'S FIX (2026-08-15).
   *
   * This first refused to store a nameless result. That looked cautious and was
   * in fact the single slowest thing left in the app for the audience it is
   * BUILT for: a lite account has no Hive account by definition, so viewing
   * their own profile spends a full ~360ms chain round trip to rediscover that,
   * on every single load. Measured: chain profiles 31ms warm, lite profiles
   * 416ms — the cache was helping everyone except the people the product is for.
   *
   * Caching it is safe because of a distinction the chain client already makes,
   * and which the layout's own 429 note depends on: a RATE-LIMITED call
   * REJECTS. A rejection never reaches this `.then`, so it is never stored —
   * the 429 that once 404'd /@blocktrades still cannot be remembered. Only a
   * clean, completed answer of "no such account" is, and only for 10 seconds
   * (see `ttlFor`), so an account created seconds ago appears almost at once.
   */
  ttlFor: (account) => (account && account.name ? 30_000 : 10_000)
});

/**
 * Cached `getAccountFull`: request-level dedup (React `cache()`) over a 30s
 * cross-request layer. See the note above for why both are needed.
 */
export const getAccountFullCached = cache(accountFullTtl);

/**
 * Request-level cached version of getPost.
 * Deduplicates calls within the same request (e.g., generateMetadata + page).
 */
export const getPostCached = cache(getPost);

/**
 * ★★★ THE PROFILE'S REMAINING TTFB WAS THE PREFETCH BUDGET ITSELF (2026-08-15).
 *
 * After the account read above was cached, `/@lordbutterfly` still answered in a
 * flat 404-412ms on every repeat — suspiciously stable, and exactly
 * `PREFETCH_BUDGET_MS = 400`. That is the tell: the layout races its prefetches
 * against a 400ms timer, and the two chain reads it waits on
 * (`get_account_reputations` ~362ms, `get_dynamic_global_properties` ~364ms,
 * measured in that file's own note) never beat the timer. So TTFB was not
 * "however long the work takes" — it was PINNED at the budget, every time.
 *
 * Caching the account alone could never fix that; it only stopped the budget
 * being paid ON TOP of a 360ms account read (cold 1073ms -> warm 405ms). The
 * budget itself only goes away when the prefetches can actually resolve inside
 * it, which means they have to be answerable without a round trip.
 *
 * ★ TTLs chosen from what the values ARE, not from taste:
 *
 *  · `getDynamicGlobalProperties` is GLOBAL — not keyed on anything — so one
 *    entry serves every reader and every route, and the hit rate is ~100% after
 *    the first request. The chain advances every 3 seconds, but nothing on a
 *    profile reads a block number off it; it is there for the vesting-to-HP
 *    conversion, whose inputs (total_vesting_fund_hive / total_vesting_shares)
 *    move by fractions of a percent per hour. 20s is far tighter than the data
 *    needs and still collapses the call.
 *
 *  · Reputation is per-account and moves when votes land. 60s.
 *
 * Both are PREFETCHES — their only job is to seed the React Query cache so the
 * browser does not refetch, and every one has a client-side path that fetches
 * if the dehydrated state lacks it. A stale one costs a reader nothing; a slow
 * one costs every reader 400ms.
 *
 * NOT applied to the wallet, which calls `getDynamicGlobalProperties` directly
 * for money math and must keep doing so.
 */
export const getDynamicGlobalPropertiesCached = withTtlCache(
  getDynamicGlobalProperties,
  () => 'dgp',
  { ttlMs: 20_000, max: 1 }
);

export const getAccountReputationsCached = withTtlCache(
  getAccountReputations,
  (username: string, limit: number) => `${username}|${limit}`,
  { ttlMs: 60_000, max: 500 }
);
