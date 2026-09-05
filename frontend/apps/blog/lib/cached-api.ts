import { cache } from 'react';
import type { Entry, FollowListType } from '@hive/common-hiveio-packages/wax';
import {
  getAccountFull,
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
import { registerCache } from '@/blog/lib/cache-registry';

/**
 * ★★★ THE PER-WORKER BYTE BUDGET OF EVERYTHING IN THIS FILE: ~75 MB at the caps
 * below, ~95 MB including `getCommunitiesCached`, which is left alone. That is
 * PER WORKER, x3 cluster workers on a 7.9 GB box (2026-09-05). SIZE AGAINST THAT
 * NUMBER, not against "500 sounds fine" — every `max` here is a RESIDENCY
 * commitment per worker, not a hit-rate knob.
 *
 * ★★ AND EVERY RATE BELOW IS PER WORKER TOO. This is the arithmetic error the
 * first version of this pass made: the measured traffic figures are WHOLE-BOX
 * (~870 profile renders/hour, ~2200 post-page requests/10min), while each of
 * these Maps lives in ONE worker of `LUMEN_WORKERS`=3. Every rate must be divided
 * by 3 before it is compared with a cap. The caps were kept where the wrong
 * arithmetic put them, because that error was in the SAFE direction — it sized
 * them for 3x the traffic any single worker sees — but the numbers in each
 * comment are now the per-worker ones, so the next person sizing these starts
 * from the truth.
 *
 * Worst case is `max` x per-entry size, and only the first line is MEASURED:
 *   · accountPostsFirstPageTtl  60 x ~870 KB (raw, untrimmed)  ~= 52 MB  [measured]
 *   · getDiscussionCached      100 x ~200 KB (full reply tree) ~= 20 MB  [estimate]
 *   · getCommunitiesCached     200 x small list records        ~= 20 MB  [estimate, unchanged]
 *   · getCommunityCached / getAccountFullCached / getFollowListCached /
 *     getFollowers / getFollowing — 100 each x small records (a follow list is
 *     50 x {follower, following, what[]})                      ~=  3 MB total
 *
 * Before this pass the same table read ~435 MB for the posts cache ALONE. The
 * caps were never reached by repeat traffic paying for itself; they were reached
 * by dead entries nobody read twice — see `server-ttl-cache.ts`'s header for the
 * measurement, and note the sweep added there floors steady-state residency near
 * `max/2` under distinct-key crawler traffic, so the typical figure is roughly
 * half the worst case above.
 *
 * ★ CHECK IT INSTEAD OF TRUSTING IT: every cache here registers with
 * `lib/cache-registry.ts`, and `/api/debug/mem` (gated on `DENSER_DEBUG_MEM`)
 * reports each one's live `size` alongside `sweeps`/`swept`/`evictions`. A `size`
 * pinned at its cap with `evictions` climbing means the cap is the binding
 * constraint and this budget is understated.
 *
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
  /*
   * ★ 500 -> 100 (2026-09-05, box memory pass). THIS ONE IS NOT ABOUT BYTES.
   * An account record is small (~10 KB), so 500 of them was never the memory
   * problem the posts cache was; what it was, was 500 RESIDENT DEAD RECORDS.
   * Under crawler traffic across 868 distinct accounts every key is a miss,
   * nothing is read twice, and the only thing that ever removed an entry was a
   * read past `staleUntil` or the cap itself — so this map sat permanently full
   * of accounts whose 60s lifetime ended long ago. The sweep in
   * `server-ttl-cache.ts` is what actually reclaims them; this cap just stops the
   * ceiling being five times higher than any real working set.
   *
   * THE ARITHMETIC, PER WORKER: lifetime is 30s TTL + 30s stale window = 60s.
   * ~870 profile renders/hour whole-box / 3 workers = ~4.8 renders/min/worker,
   * so ~4.8/min x 60s ~= 5 entries can be alive in one worker at once. 100 is 20x
   * that, which is deliberate generosity for the hottest key space in the app:
   * unlike the posts cache this one is cheap per entry, so headroom costs almost
   * nothing and an eviction here would cost a ~360ms round trip.
   */
  max: 100,
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
 * ★★★ BOTH PROFILE-PREFETCH WRAPPERS ARE GONE — A TOMBSTONE, NOT AN OVERSIGHT.
 *
 * `getAccountReputationsCached` (deleted 2026-09-05, box memory pass) and
 * `getDynamicGlobalPropertiesCached` (deleted 2026-09-05, earlier the same day)
 * were a pair: 60s and 20s wrappers that existed only to let the profile
 * layout's prefetch race resolve inside `PREFETCH_BUDGET_MS` without a ~360ms
 * round trip each.
 *
 * Commit 1c68664 rewrote that prefetch and removed both call sites, leaving two
 * caches with ZERO readers. `getDynamicGlobalPropertiesCached` went first; the
 * reputation wrapper survived only because nothing pointed at it either way. It
 * is dead for a stronger reason than "unused": reputation never needed a second
 * round trip at all, since `getAccountFull`/`getProfileInfo` already attach it
 * from the same `bridge.get_profile` call the layout awaits, and `ProfileMain`
 * renders it from `profileData.reputation`. See the long note at
 * `app/[param]/(user-profile)/layout.tsx` (accountReputationData /
 * dynamicGlobalData REMOVED FROM THIS PREFETCH) for the full reasoning and the
 * grep that established it — that note still names this symbol, deliberately, as
 * the record of what was removed.
 *
 * Every surviving caller of either underlying read — the wallet, for money math,
 * and the profile layout — calls the RAW `getAccountReputations` /
 * `getDynamicGlobalProperties` and always did. Re-add a wrapper only alongside a
 * reader that actually wants one, never on the assumption that a cache is free:
 * an unread cache is not free, it is `max` entries of resident bytes per worker
 * (see this file's budget note at the top).
 */

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
    /*
     * ★★★ 500 -> 60: THE SINGLE BIGGEST MAP IN THE PROCESS (2026-09-05, box
     * memory pass). This one stores the RAW `getAccountPosts` page — the trim
     * in `posts-page.tsx` runs on the RETURNED array and builds new objects
     * (`trimEntriesForSeed` maps, see seed-trim.ts), so what sits in here is the
     * untrimmed ~870 KB payload that file's own comment measured, not the
     * ~127 KB trimmed one.
     *
     * THE ARITHMETIC, PER WORKER — and the per-worker part is the correction that
     * matters (see this file's header). Lifetime of an entry is 25s TTL + 25s
     * stale window = 50s. Measured traffic is ~870 profile renders/hour, but that
     * is WHOLE-BOX across `LUMEN_WORKERS`=3, so one worker sees ~290/hour =
     * ~0.081/s. Crawlers walk DISTINCT accounts (868 distinct in that hour), so
     * essentially every render is a new key: 0.081/s x 50s ~= 4 entries can be
     * simultaneously alive IN ONE WORKER'S MAP.
     *
     * 60 is therefore ~15x the live set, not the ~5x the whole-box figure
     * suggested. The cap is left at 60 anyway: the error ran in the safe
     * direction, 60 x 870 KB is already only ~52 MB, and a cap this far above the
     * working set means evictions never fight the sweep for a value someone is
     * about to read.
     *
     * THE BYTES, which is the actual point: 500 x ~870 KB ~= 435 MB per worker,
     * x3 workers on a 7.9 GB box. At 60: ~52 MB per worker. The old cap was never
     * reached by REPEAT traffic paying for itself — it was reached by 500 dead
     * payloads that expired 50 seconds ago and stayed resident because nobody
     * ever read that key again (see `server-ttl-cache.ts`'s header).
     *
     * The TTL, the stale window and `shouldCache` are all UNCHANGED: a warm
     * profile is exactly as warm as before, because at 12 live entries against a
     * 60 cap nothing evictable was ever being evicted for cache-hit reasons.
     */
    max: 60,
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
/*
 * ★★ 500 -> 100 (2026-09-05, box memory pass). A full comment TREE per entry —
 * every reply body on a post — so this is the second-largest map here after the
 * posts page above (not separately measured in bytes; it is bounded by the post's
 * reply count, and a busy post's tree is comfortably into the hundreds of KB).
 *
 * THE ARITHMETIC, PER WORKER (see this file's header on why that qualifier is
 * the whole point). Lifetime is 30s (TTL, no stale window). Measured post-page
 * traffic is ~2200 requests/10min = 3.67/s over distinct posts WHOLE-BOX, which
 * across `LUMEN_WORKERS`=3 is ~1.22/s per worker: ~1.22 x 30 ~= 37 entries alive
 * in one worker's map at once.
 *
 * So 100 is ~2.7x the live set rather than sitting exactly ON it, as the earlier
 * whole-box figure of ~110 wrongly implied. Kept at 100: the mistake was in the
 * safe direction, and this is the largest per-entry value here after the posts
 * page, so buying more headroom than 2.7x is not obviously worth the bytes. TTL
 * and semantics unchanged.
 */
export const getDiscussionCached = withTtlCache(
  getDiscussion,
  (author: string, permlink: string, observer?: string) => `${author}|${permlink}|${observer ?? ''}`,
  { ttlMs: 30_000, max: 100 }
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
/*
 * ★ 500 -> 100 (2026-09-05, box memory pass). Small values (title, description,
 * subscriber count) but the same "one cap per worker, three workers" arithmetic,
 * and the key space here is far SMALLER than the traffic: distinct communities
 * number in the hundreds across the whole site, and a 30s lifetime at post-page
 * rates only ever has a handful of them live at once. 100 is well above the
 * plausible live set and the map should now sit far below its cap rather than
 * pinned at it. TTL, key shape and semantics unchanged.
 */
export const getCommunityCached = withTtlCache(
  getCommunity,
  (name: string, observer?: string, options?: GetCommunityOptions) =>
    `${name}|${observer ?? ''}|${options?.correctSubscribers ?? true}`,
  { ttlMs: 30_000, max: 100 }
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
/*
 * ★ 500 -> 100 (2026-09-05, box memory pass). Moderate values (one observer's
 * muted/blacklist name list), 30s TTL unchanged. Keyed on the OBSERVER, so the
 * live set is bounded by concurrent SIGNED-IN readers of post pages inside a 30s
 * window — the measured crawler load is anonymous and never reaches this cache at
 * all (`page.tsx` calls it only when `isLoggedIn`). 100 is far above that live
 * set. Key shape untouched: dropping either half would leak one viewer's muted
 * list to another, which this cache's own note above calls its hard line.
 */
export const getFollowListCached = withTtlCache(
  getFollowList,
  (observer: string, follow_type: FollowListType) => `${observer}|${follow_type}`,
  { ttlMs: 30_000, max: 100 }
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
/*
 * ★ 500 -> 100 EACH (2026-09-05, box memory pass). A follower/following page is
 * a list of up to `limit` account records, so neither is small, and there are TWO
 * of these maps. `/@user/followers` and `/@user/following` are a small fraction of
 * profile traffic (the crawler load measured is on the profile ROOT), so at a 30s
 * lifetime the live set is single digits; 100 each is generous against that and
 * 800 fewer resident list objects per worker than before. TTL and key shape
 * unchanged — the full param tuple still keys them, so pagination still cannot
 * collide.
 */
export const getFollowersCached = withTtlCache(getFollowers, followParamsKey, { ttlMs: 30_000, max: 100 });
export const getFollowingCached = withTtlCache(getFollowing, followParamsKey, { ttlMs: 30_000, max: 100 });

/**
 * ★★★ EVERY CACHE ABOVE, REGISTERED FOR `/api/debug/mem` (2026-09-05, box memory
 * pass). One block rather than a line beside each cache, so that "is anything
 * unregistered?" is answerable by reading twelve lines instead of grepping the
 * file — the failure mode being an instrument that silently omits the one map
 * that is actually growing.
 *
 * ★ `accountFullTtl`, NOT `getAccountFullCached`: the export is wrapped in
 * React's `cache()`, which returns a fresh memoizing function that does not
 * carry `.stats` (the same reason that export is cast on its way through
 * `cache()` — see its own note). The TTL instance is the thing holding bytes, so
 * the TTL instance is the thing measured.
 *
 * Registration happens at module load, so a worker that has served no profile or
 * post page reports nothing at all — see `allCacheStats`'s note on why an empty
 * result is a true answer rather than a broken instrument.
 */
registerCache('accountFull', accountFullTtl.stats);
registerCache('accountPostsFirstPage', accountPostsFirstPageTtl.stats);
registerCache('communities', getCommunitiesCached.stats);
registerCache('community', getCommunityCached.stats);
registerCache('discussion', getDiscussionCached.stats);
registerCache('followList', getFollowListCached.stats);
registerCache('followers', getFollowersCached.stats);
registerCache('following', getFollowingCached.stats);
