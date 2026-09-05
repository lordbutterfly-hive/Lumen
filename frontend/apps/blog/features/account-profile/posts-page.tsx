import { ReactNode } from 'react';
import { QueryTypes } from './lib/utils';
import { getObserverFromCookies } from '@/blog/lib/auth-utils';
import { getLogger } from '@ui/lib/logging';
import { ObserverProvider, InitialPostsProvider } from '@/blog/components/observer-provider';
import { extractUsernameFromParam } from '@/blog/utils/validate-links';
import { attachLiteIdentities } from '@/blog/lib/lite/render/attach-lite';
import { filterBlockedForViewer, viewerBlockedKeySet } from '@/blog/lib/lite/social/block-filter';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { trimEntriesForSeed } from '@/blog/lib/feed/seed-trim';
import { anonymousAccountPostsSeed } from '@/blog/lib/feed/account-posts-seed-cache';
import { mergeLumenEngagement } from '@/blog/lib/lite/repositories/engagement-repository';
import { getAccountPostsCached } from '@/blog/lib/cached-api';

const logger = getLogger('app');

/**
 * ★★★ CACHED + BUDGETED (2026-09-05, perf batch C-A). This used to call the
 * raw, uncached `getAccountPosts` below, during the RSC render, on every
 * single view of a profile -- the slowest read in the app (~1MB, 0.4-6s
 * against api.hive.blog, never settling to a stable number). `getAccountPostsCached`
 * (lib/cached-api.ts) puts a 25s cross-request cache in front of exactly the
 * first-page read this component always asks for.
 *
 * A COLD cache still costs the full round trip, so the fetch below races it
 * against a short deadline -- the render must not wait out a slow upstream any
 * more than the profile layout already refuses to (see
 * `(user-profile)/layout.tsx`'s own `PREFETCH_BUDGET_MS`). Losing the race
 * leaves `initialPosts` empty and falls through to the anonymous seed cache
 * further down exactly like today's "seed came back empty" path already does
 * -- a cold miss is not a new failure mode here, it is the existing one,
 * just reached sooner.
 *
 * The losing promise is deliberately NOT abandoned: it keeps running after the
 * timer wins, and `server-ttl-cache.ts` stores its result when it finally
 * resolves, so the next reader in the 25s window gets a warm cache. Its own
 * eventual rejection is swallowed at the call site (`.catch(() => undefined)`)
 * for the same reason `feed-prefetch.ts`'s `withTimeout` does: nobody is still
 * awaiting it, so an unhandled rejection would otherwise crash the process on
 * the next 429.
 */
const POSTS_PREFETCH_BUDGET_MS = 500;

const PostsPage = async ({
  children,
  param,
  query
}: {
  children: ReactNode;
  param: string;
  query: QueryTypes;
}) => {
  const username = extractUsernameFromParam(param) ?? param;
  const observer = await getObserverFromCookies();
  let initialPosts = null;
  try {
    const postsPromise = getAccountPostsCached(query, username, observer);
    initialPosts =
      (await Promise.race([
        postsPromise,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), POSTS_PREFETCH_BUDGET_MS))
      ])) ?? null;
    // The loser of the race above is never abandoned -- see this file's
    // `POSTS_PREFETCH_BUDGET_MS` comment for why it keeps running and why its
    // eventual rejection must be swallowed here.
    void postsPromise.catch(() => undefined);
      // Resolve Lumen identities before this reaches the browser, so a lite post
      // never renders under the shared publishing account and then corrects itself.
      if (initialPosts) await attachLiteIdentities(initialPosts);
    // ★ THE READER'S OWN BLOCK LIST, SERVER-SIDE (2026-08-23).
    //
    // This is the half that actually closes the leak. This component is a SERVER
    // component: it fetches here and seeds `InitialPostsProvider` below, so a blocked
    // author's posts were already in the server-rendered HTML before any JavaScript ran.
    // A client-side filter cannot retract that — it only removes them a round trip later,
    // and never at all for a reader with JS disabled or for anything reading the raw
    // document. The matching client filter still belongs downstream so the two agree and
    // there is no flash; this one is what makes the HTML honest.
    //
    // `filterBlockedForViewer` returns a NEW array (unlike `attachLiteIdentities`, which
    // mutates in place), so the result must be assigned.
    //
    // Anonymous readers are unaffected: no session means no block list means an empty key
    // set and an untouched array. Degrades OPEN on failure, matching `feed/for-you` and
    // `/api/account-posts` — the reader's own preference must not blank a profile over a
    // database hiccup.
    if (initialPosts) {
      const viewerSession = await getLiteSession();
      const blockedKeys = await viewerBlockedKeySet(viewerSession.user).catch(
        () => new Set<string>()
      );
      if (blockedKeys.size > 0) {
        initialPosts = await filterBlockedForViewer(initialPosts, blockedKeys);
      }
      // ★ MERGE LUMEN ENGAGEMENT INTO THE SEED (T1g, 2026-09-04). `getAccountPosts`
      // above is a raw chain read; Lumen's own vote/reblog totals (lite users' votes
      // and reblogs, which never touch the chain — see this function's own doc
      // comment) previously reached this seed nowhere. `/api/account-posts` already
      // called this before answering the browser, which is exactly why
      // `useAccountEntries` (redesign/hooks/use-account-entries.ts) had to seed
      // `initialDataUpdatedAt: 0` — a fresh-looking seed with no merge froze a
      // reader's just-cast Lumen vote at its pre-vote count. Doing the same merge
      // here closes that gap, so the seed and a live `/api/account-posts` response
      // now agree, and that hook no longer needs the immediate refetch to fix the
      // numbers (own doc there). Same direct-DB call that route makes; not a
      // loopback HTTP self-fetch.
      initialPosts = await mergeLumenEngagement(initialPosts);
      // ★ TRIM THE SEED TO WHAT A CARD SHOWS (snappiness phase 3, 2026-09-03).
      // getAccountPosts returns full bodies and full vote lists; a profile card
      // needs only a plaintext dek and the viewer's own vote. Untrimmed this
      // seed measured ~870 KB per profile (77% vote lists, 18% bodies); trimmed
      // ~127 KB. Same helper the feed uses (lib/feed/seed-trim.ts).
      initialPosts = trimEntriesForSeed(initialPosts, viewerSession.user?.username ?? '');
    }
  } catch (error) {
    logger.error(error, 'Error in PostsPage:');
  }
  // ★ FALLBACK WHEN THE RENDER-CONTEXT SEED CAME BACK EMPTY (2026-09-03).
  //
  // `getAccountPosts` above is a wax chain read issued DURING the RSC render and
  // it fails in the render context (empty seed => no posts in the SSR HTML =>
  // the browser refetches ~1.4s later; the profile is our slowest page for
  // exactly this). The render must do NO network to fix it - an earlier loopback
  // self-fetch per render starved the single-process event loop under crawler
  // load and 502'd the origin (see account-posts-seed-cache.ts).
  //
  // So for a SIGNED-OUT reader we seed from the anonymous cache that
  // /api/account-posts writes: a process-local map read, zero network. The
  // client's own fetch populates it, so the next reader's render paints from it.
  // Signed-in readers are never seeded from the shared anonymous cache (their
  // block list and own vote are per-request) - they fall through to the client
  // fetch exactly as before. Cold miss = today's behaviour, never worse.
  if (!initialPosts || initialPosts.length === 0) {
    const viewerSession = await getLiteSession();
    if (!viewerSession.user) {
      const cached = anonymousAccountPostsSeed(query, username);
      if (cached && cached.length > 0) initialPosts = cached;
    }
  }
  // Pass data directly via context instead of Hydrate/dehydrate.
  // React Query v4's <Hydrate> has compatibility issues with Next.js App Router
  // streaming SSR where dehydrated state doesn't reliably reach the browser
  // query client, causing unnecessary client-side refetches.
  return (
    <ObserverProvider value={observer}>
      <InitialPostsProvider value={initialPosts}>{children}</InitialPostsProvider>
    </ObserverProvider>
  );
};
export default PostsPage;
