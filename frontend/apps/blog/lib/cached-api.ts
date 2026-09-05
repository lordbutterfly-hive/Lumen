import { cache } from 'react';
import type { Entry, FollowListType } from '@hive/common-hiveio-packages/wax';
import {
  getAccountFull,
  getAccountReputations,
  getFollowers,
  getFollowing,
  DEFAULT_PARAMS_FOR_FOLLOW,
  type IGetFollowParams
} from '@transaction/lib/hive-api';
import {
  getAccountPosts,
  getCommunities,
  getCommunity,
  getDiscussion,
  getFollowList,
  getPost,
  type GetCommunityOptions
} from '@transaction/lib/bridge-api';
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
  ttlFor: (account) => (account && account.name ? 30_000 : 10_000),
  /*
   * ★ AND THE READER WHO LANDS ON THE EXPIRY PAYS NOTHING EITHER (2026-08-17).
   *
   * The 30s above removed the round trip for 29 of every 30 seconds. It could not
   * remove it for the reader who arrives in the 30th — that one still waited the
   * full ~360ms, and on a bad upstream minute a great deal more. Past the TTL the
   * header is now served from what we hold while the refresh runs behind it.
   *
   * ★ ABSENCE GETS NO WINDOW, ON PURPOSE. `ttlFor` keeps "no such account" for
   * only 10s so a just-created account appears almost at once — the lite signup
   * path depends on it. A stale window on the absence would silently stretch that
   * to 40s, undoing the thing the short TTL was for. So: a real account may be
   * served stale, an absence never is.
   */
  staleWhileRevalidateMs: (account) => (account && account.name ? 30_000 : 0)
});

/**
 * Cached `getAccountFull`: request-level dedup (React `cache()`) over a 30s
 * cross-request layer. See the note above for why both are needed.
 *
 * ★ CAST TO A PLAIN FUNCTION TYPE BEFORE `cache()` (2026-09-05). `accountFullTtl`
 * is now a `TtlCache` (it carries `.set`, added for `primeAccountFullCache`
 * below). React's `cache()` returns a brand-new memoizing function that does
 * NOT copy that property over, but TypeScript's generic `cache<T>` signature
 * would otherwise happily claim the RESULT still has `.set` too -- a type that
 * compiles and throws at runtime the moment anyone believes it. Narrowing the
 * argument here keeps `getAccountFullCached` typed as what it actually is.
 */
export const getAccountFullCached = cache(accountFullTtl as (username: string) => ReturnType<typeof getAccountFull>);

/**
 * ★ WRITE-THROUGH FOR THE LAYOUT'S OWN RETRY (2026-09-05).
 *
 * `(user-profile)/layout.tsx` retries a rejected `getAccountFullCached` by
 * calling the raw `getAccountFull` directly — deliberately bypassing both the
 * request-scoped `cache()` above and this 30s layer, because replaying either
 * would just hand back the same already-rejected promise (see that file's own
 * comment on the retry). That retry answer used to go straight to the one
 * page that triggered it and nowhere else: the next reader within the same
 * 30s window hit the exact same rate-limited call and paid the exact same
 * retry, for as many readers as landed in that window.
 *
 * This writes the retry's successful answer into `accountFullTtl`'s own
 * store, under the same `ttlFor`/`staleWhileRevalidateMs` rules a normal load
 * would have earned — see `server-ttl-cache.ts`'s `.set` doc for why that has
 * to be the SAME store and not a second one. Call it only on success; a
 * rejected retry must never reach here, or a real outage would be primed into
 * the cache as if it were an answer (property 1, `server-ttl-cache.ts`).
 */
export function primeAccountFullCache(username: string, account: Awaited<ReturnType<typeof getAccountFull>>): void {
  accountFullTtl.set(username, account);
}

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
 *  · Reputation is per-account and moves when votes land. 60s.
 *
 * It is a PREFETCH — its only job is to seed the React Query cache so the
 * browser does not refetch, and it has a client-side path that fetches if the
 * dehydrated state lacks it. A stale one costs a reader nothing; a slow one
 * costs every reader 400ms.
 *
 * ★ WHICH IS PRECISELY WHY IT SERVES STALE (2026-08-17). "A stale one costs a
 * reader nothing" is the argument for the TTL and it is the same argument, only
 * stronger, past the TTL: at expiry it was still handing one reader per period
 * the full 400ms budget back. Refreshing behind the reader is the whole benefit
 * with none of that. The window matches the TTL — a prefetch twice its intended
 * age is still a prefetch, and the client refetches anyway.
 *
 * ★ THE OTHER HALF OF THIS PAIR, `getDynamicGlobalPropertiesCached`, IS GONE
 * (2026-09-05). It was here for the same reason and with the same 20s TTL — one
 * global entry, no key, ~100% hit rate, feeding the vesting-to-HP conversion —
 * but commit 1c68664 rewrote the profile prefetch and left it with ZERO readers
 * (grep-verified across apps/ and packages/). The only thing still calling it
 * was `warm-server-caches.ts`, i.e. it cost one real upstream call per restart
 * to fill a cache nobody read. Every remaining caller — the wallet, for money
 * math, and the profile layout — calls `getDynamicGlobalProperties` directly and
 * always did; that was already documented here as deliberate. Re-add the wrapper
 * only alongside a reader that wants it.
 */
export const getAccountReputationsCached = withTtlCache(
  getAccountReputations,
  (username: string, limit: number) => `${username}|${limit}`,
  { ttlMs: 60_000, max: 500, staleWhileRevalidateMs: 60_000 }
);

/**
 * ★★ THE COMMUNITY LIST IS THE OTHER 600ms (measured 2026-08-15).
 *
 * `features/layouts/sorts/server-side-layout.tsx` wraps the sorted-feed routes, so
 * `getCommunities` runs on each of them. Timed from this box,
 * `bridge.list_communities` answers in **629ms**, and `/communities` measured
 * 990ms cold / 335ms warm TTFB — the second-slowest server route after the
 * profile page, for the same reason: one slow upstream read with no
 * cross-request memory.
 *
 * A ranked list of communities is about as static as anything this app fetches —
 * names, titles and rank order, changing over hours. Five minutes of staleness
 * is invisible to a reader and removes the call from almost every page view.
 *
 * ★ KEYED ON THE OBSERVER, not global. `getCommunities` takes the observer, and
 * the response can carry viewer-dependent context; sharing one entry across
 * accounts would leak one reader's view of the list to another. Signed-out
 * readers all share `DEFAULT_OBSERVER`, which is where the bulk of cold traffic
 * is anyway, so they get the benefit with no cross-account risk. 200 entries
 * bounds it, and a failed read is never stored (see `server-ttl-cache.ts` — a
 * cached failure would blank the community rail for everyone for five minutes).
 *
 * ★★★ THIS IS THE WORST PLACE IN THE APP TO LAND ON AN EXPIRY (2026-08-17), which
 * is why it also serves stale. Two things compound here that do not compound
 * anywhere else: the entry is keyed on the observer, so a signed-in reader can be
 * the ONLY holder of their key and therefore pays every single expiry themselves;
 * and that layout wraps the sorted-feed routes, so the wait lands on the feed, not
 * on a page someone deliberately opened. Re-measured 2026-08-17 with a cold
 * upstream: `bridge.list_communities` took **6.6s** against the 629ms recorded
 * above, and `/communities` answered in 7.9s and 13.4s while the warm render is
 * 61ms. Five minutes of staleness was already ruled invisible; ten is invisible
 * for the same reason, and it means no reader ever waits for this list again.
 *
 * ★ IT LIVES HERE, NOT IN THE LAYOUT (moved 2026-08-17), for one reason: the
 * FIRST reader after a deploy still found an empty cache and paid the whole cost,
 * which serve-stale cannot help with — there is nothing stale to serve yet. Only
 * a boot warm fixes that, and a boot warm must be able to import this without
 * dragging a React layout and its client components into server startup. See
 * `lib/warm-server-caches.ts`.
 */
export const getCommunitiesCached = withTtlCache(
  getCommunities,
  (_sort: string, _query: string | null, observer?: string) => `${_sort}|${_query ?? ''}|${observer ?? ''}`,
  { ttlMs: 300_000, max: 200, staleWhileRevalidateMs: 300_000 }
);

/**
 * ★★★ THE PROFILE'S POSTS TAB — THE SLOWEST PAGE IN THE APP (2026-09-05,
 * perf batch C-A). `posts-page.tsx` seeds the Posts/Feed/Comments tabs with a
 * `getAccountPosts` chain read issued DURING the RSC render, uncached, on
 * every single view — a ~1MB response (see that file's own trim comment) with
 * no cross-request memory at all, unlike every other read on the profile.
 *
 * Only the FIRST page of ONE sort for ONE (username, observer) pair is ever
 * cached — this wrapper fixes `start_author`/`start_permlink` to `''` and the
 * limit to `getAccountPosts`'s own default, matching the one call site
 * (`posts-page.tsx`'s SSR seed) exactly. It is deliberately not a general
 * pass-through for arbitrary pagination: a key of only `sort|account|observer`
 * would otherwise answer a page-2 request with page 1's cached entries.
 *
 * KEYED ON THE OBSERVER, same reasoning as `getCommunitiesCached`: the reply
 * can carry viewer-dependent context (the observer's own vote on each entry),
 * so sharing one entry across observers would leak one reader's view to
 * another.
 *
 * 25s, not 30s like the account header: this is the far larger payload of the
 * two, and this app's own posture (`server-ttl-cache.ts` header) is to keep a
 * TTL close to what the data can tolerate rather than round up. `shouldCache`
 * refuses an empty/absent result — an upstream hiccup must not serve "no
 * posts" to every reader of a profile for the next 25 seconds. `staleWhileRevalidateMs`
 * matches the TTL for the same reason `getCommunitiesCached` serves stale: the
 * reader who lands on the expiry must not pay the ~1MB round trip themselves.
 */
const accountPostsFirstPageTtl = withTtlCache(
  (sort: string, account: string, observer: string) => getAccountPosts(sort, account, observer, '', ''),
  (sort: string, account: string, observer: string) => `${sort}|${account}|${observer}`,
  {
    ttlMs: 25_000,
    max: 500,
    shouldCache: (entries) => Array.isArray(entries) && entries.length > 0,
    staleWhileRevalidateMs: 25_000
  }
);

/**
 * Cached first page of a profile's posts feed, budgeted against a short
 * deadline by the caller (see `posts-page.tsx`) — this function itself never
 * times out, it only makes a warm/stale answer free and lets a cold miss keep
 * running to fill the cache for the next reader, exactly like
 * `trendingForPrefetch` in `feed-prefetch.ts`.
 */
export async function getAccountPostsCached(
  sort: string,
  account: string,
  observer: string
): Promise<Entry[] | null> {
  return accountPostsFirstPageTtl(sort, account, observer);
}

/**
 * ★ getDiscussion, CACHED (2026-09-05, perf batch C-A). The comment tree for
 * one post, keyed on (author, permlink, observer) — the observer matters here
 * for the same reason it does on `getCommunitiesCached`: Hivemind's own reply
 * carries viewer-dependent muting, so two observers must never share an entry.
 * 30s: a comment tree changes as replies land, and this trades a small,
 * bounded staleness (a reply appearing up to 30s late to a DIFFERENT reader
 * than the one who just posted it — their own render is not cached, see
 * `cache()`'s request scope) for removing the read from every repeat view of
 * a popular post. A failed/absent read is never stored (default `keep`), so a
 * transient 429 cannot freeze "no discussion" in for 30 seconds.
 */
export const getDiscussionCached = withTtlCache(
  getDiscussion,
  (author: string, permlink: string, observer?: string) => `${author}|${permlink}|${observer ?? ''}`,
  { ttlMs: 30_000, max: 500 }
);

/**
 * ★ getCommunity, CACHED (2026-09-05, perf batch C-A) — the SINGLE-community
 * lookup, not the list `getCommunitiesCached` above already covers. Keyed on
 * (name, observer) for the same viewer-dependent-context reason as every
 * other observer-keyed entry in this file. 30s: a community's title,
 * description and subscriber count move on the order of hours, not seconds,
 * and `getCommunity` itself already costs seven upstream round trips (see its
 * own comment in bridge-api.ts) — collapsing repeat renders of the same
 * community page is exactly the shape `getCommunitiesCached` was built for,
 * one level down. Absence/failure is never stored (default `keep`).
 *
 * ★ KEY ALSO CARRIES `correctSubscribers` (2026-09-05, post-page TTFB pass).
 * `getCommunity` now takes that option (see its own doc in bridge-api.ts) so
 * the post page can decline the banned-subscriber-count correction it never
 * displays. Folding the flag into the key — not just forwarding it — keeps a
 * `correctSubscribers:false` post-page read and a `correctSubscribers:true`
 * community-page read (`prefetch-component.tsx`, community layout metadata)
 * in SEPARATE cache entries: without this, whichever one missed first would
 * cache its answer under the bare `name|observer` key and silently hand the
 * OTHER caller the wrong count for up to 30s — a corrected count going raw on
 * the community page, or (harmless but pointless) a raw request paying for a
 * correction it doesn't use. Every existing caller omits the option and
 * therefore keys identically to before (`options?.correctSubscribers ?? true`
 * reproduces the old `name|observer` behaviour exactly).
 */
export const getCommunityCached = withTtlCache(
  getCommunity,
  (name: string, observer?: string, options?: GetCommunityOptions) =>
    `${name}|${observer ?? ''}|${options?.correctSubscribers ?? true}`,
  { ttlMs: 30_000, max: 500 }
);

/**
 * ★ getFollowList, CACHED — POST-PAGE MUTED-LIST SEED ONLY (2026-09-05, perf
 * batch C-A). This was the one fan-out branch in `page.tsx`'s
 * `Promise.allSettled` with no cross-request memory at all — every sibling
 * there (`getPostCached`, `getDiscussionCached`, `getCommunityCached`) already
 * had one — so every signed-in reader's post-page render paid a fresh
 * `bridge.get_follow_list` round trip just to seed the muted-list filter for
 * first paint.
 *
 * ★★★ KEYED ON (observer, follow_type) TOGETHER — NEITHER HALF IS OPTIONAL.
 * `get_follow_list`'s `observer` IS the viewer whose list is being read (see
 * `bridge-api.ts`), so dropping it would serve viewer A's muted/blacklist rows
 * to viewer B — the one thing every other observer-keyed entry in this file
 * (`getCommunitiesCached`, `getDiscussionCached`, `getCommunityCached`) exists
 * to prevent, and the hard line for this cache specifically. Dropping
 * `follow_type` would let a cached 'muted' answer satisfy a
 * 'follow_blacklist' (or any other type) request instead. The key below is
 * `${observer}|${follow_type}` and nothing else, so neither collapse is
 * possible.
 *
 * ★ SCOPE, DELIBERATELY NARROW — ONLY `page.tsx`'s post-page seed is wired to
 * this. `getFollowList`'s other three call sites stay on the RAW function,
 * unchanged: `/api/follow-list` (what the client's own
 * `useFollowListQuery`/`fetchFollowList` hits after hydration — including the
 * SAME post page's own client-side re-check via `useModerationStatus`),
 * `settings/page.tsx`, and `lib/lite/social/chain-mute.ts`. This is also NOT
 * the path anything follow/DM-gating logic reads: Lumen's own `isFollowing`
 * (DM request-vs-open gating, `lib/lite/repositories/follow-repository.ts`)
 * is a separate DB-backed "lite" follow system that never calls
 * `getFollowList` — nothing there can go stale from this cache existing.
 *
 * ★ A SELF-MUTE STAYS INSTANT ON THE PAGE THAT MADE IT. Mute/unmute
 * (`use-mute-mutations.ts`) is a pure client-side React Query mutation:
 * `onMutate`/`onSettled` call `setQueryData`/`invalidateQueries` directly on
 * the browser's own `['muted', username]` entry, which `useFollowListQuery`
 * reads on the current page — neither this server cache nor the SSR seed it
 * feeds is ever in that path. The 30s window here only bounds how stale a
 * BRAND-NEW SSR render (a fresh navigation or reload) of this reader's own
 * post page can be relative to a mute/unmute they just made elsewhere — a
 * just-muted account still filtering into a fresh page load for up to 30s,
 * which is the one staleness this cache is scoped to accept (see the caller's
 * own note). A failed/absent read is never stored (default `keep`).
 */
export const getFollowListCached = withTtlCache(
  getFollowList,
  (observer: string, follow_type: FollowListType) => `${observer}|${follow_type}`,
  { ttlMs: 30_000, max: 500 }
);

/** Same key shape both `getFollowersCached` and `getFollowingCached` use. */
const followParamsKey = (params?: Partial<IGetFollowParams>): string =>
  `${params?.account || DEFAULT_PARAMS_FOR_FOLLOW.account}|${params?.start || ''}|${
    params?.type || DEFAULT_PARAMS_FOR_FOLLOW.type
  }|${params?.limit || DEFAULT_PARAMS_FOR_FOLLOW.limit}`;

/**
 * ★ getFollowers / getFollowing, CACHED (2026-09-05, perf batch C-A). Both are
 * bare, uncached upstream reads today — `/@user/followers` and
 * `/@user/following` hit them fresh on every view — and unlike a profile
 * header neither result is viewer-dependent: two different observers looking
 * at the same account's follower list see the same list. Keyed on the full
 * param tuple (account, start cursor, type,
 * limit), not just the account, so a paginated request can never be answered
 * from a different page's cache entry — the same reasoning
 * `getAccountPostsCached` above states for why it fixes its own cursor rather
 * than keying on it. 30s, matching every other short-lived read in this file;
 * a failed read is never stored (default `keep`), matching the "failures are
 * never cached" property this whole module is built around.
 */
export const getFollowersCached = withTtlCache(getFollowers, followParamsKey, { ttlMs: 30_000, max: 500 });
export const getFollowingCached = withTtlCache(getFollowing, followParamsKey, { ttlMs: 30_000, max: 500 });
