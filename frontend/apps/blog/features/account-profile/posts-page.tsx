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
import {
  postsPrefetchBudgetMs,
  POSTS_PREFETCH_BUDGET_MS
} from '@/blog/lib/feed/posts-prefetch-budget';
import { renderTimer } from '@/blog/lib/render-timing';

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
 *
 * ★★★ THE DEADLINE IS NOW CHOSEN BY AUDIENCE (2026-09-05, cold-profile fix).
 * "A short deadline" above was ONE number, 500ms, for everybody, and a cold
 * `get_account_posts` (0.5-2s) loses that race every time -- measured on prod,
 * 5 of 8 never-visited profiles were served with ZERO articles in the HTML.
 * For a SIGNED-IN reader that stays exactly as it is: their page is never held
 * by a shared cache and their client refetch fills it a beat later. For an
 * ANONYMOUS reader it is the wrong trade, because that render is cached at the
 * edge for 300s (`lib/anonymous-cache-policy.ts`) and the empty page is then
 * handed to every anonymous visitor for minutes -- so they wait longer, once,
 * on behalf of all of them. Both numbers and the full reasoning live in
 * `lib/feed/posts-prefetch-budget.ts`; the losing-promise behaviour above is
 * unchanged for either audience.
 */

/**
 * The deadline's own answer, kept DISTINCT from `null`: `getAccountPostsCached`
 * can itself resolve null, so null alone cannot tell "the upstream answered
 * nothing" from "the budget expired" -- and won/lost is precisely the number
 * the audience split has to be judged on. Nothing about the race changes.
 */
const BUDGET_EXPIRED = Symbol('posts-prefetch-budget-expired');

const PostsPage = async ({
  children,
  param,
  query
}: {
  children: ReactNode;
  param: string;
  query: QueryTypes;
}) => {
  const timer = renderTimer('profile-posts');
  const username = extractUsernameFromParam(param) ?? param;
  // ★ ONE session read, HOISTED -- AND RUN ALONGSIDE THE OBSERVER (2026-09-05).
  // The session was read twice further down (once for the block list, once for
  // the anonymous-seed fallback) and the budget below has to know the audience
  // BEFORE the race, so it moves up here. In PARALLEL with the observer cookie
  // read, deliberately: two sequential awaits would have made a signed-in
  // reader's critical path longer than it was before this change, and neither
  // read needs the other's answer.
  //
  // ★ A FAILED SESSION READ DEGRADES TO AN ANONYMOUS ONE. Hoisting took this
  // out of the try/catch that used to cover it, and iron-session genuinely can
  // throw on a cookie it cannot unseal (a rotated
  // DENSER_SERVER_SECRET_COOKIE_PASSWORD, a truncated cookie). Rendering the
  // profile as signed-OUT is exactly what an absent cookie already does and is
  // always safe -- serving a 500 for the whole page is not. `null`, not a
  // hand-built session object: nothing below reads anything but `.user`, and a
  // fake `IronSession` would be a lie about `save`/`destroy`.
  const [observer, viewerSession] = await Promise.all([
    getObserverFromCookies(),
    getLiteSession().catch((error) => {
      logger.warn(error, 'getLiteSession failed in PostsPage; rendering as anonymous');
      return null;
    })
  ]);
  const isSignedIn = Boolean(viewerSession?.user);
  timer.mark('session');
  // ★★★ PEEK AT THE ANONYMOUS SEED BEFORE THE RACE, NOT AFTER (2026-09-05,
  // review). This is a process-local map lookup with zero network (see
  // account-posts-seed-cache.ts) and it decides how long the race below may
  // run: with a usable seed ALREADY IN HAND there is nothing to wait 3.5s for.
  // A fast upstream still wins the short race and gives fresher data; a slow
  // one loses in 500ms and the reader gets the seed immediately instead of
  // staring at a 3.5s wait for an answer we were holding all along. Only a
  // reader we have nothing at all for pays the long budget.
  //
  // Read ONCE, here, and reused by the fallback at the bottom -- this call also
  // touches the seed cache's LRU, so calling it twice per render would be two
  // touches for one reader. Signed-in readers never read this shared cache
  // (their block list and own vote are per-request), which `isSignedIn ? null`
  // now enforces by construction rather than by a guard further down.
  const anonSeed = isSignedIn ? null : anonymousAccountPostsSeed(query, username);
  const hasAnonSeed = Boolean(anonSeed && anonSeed.length > 0);
  const budgetMs = hasAnonSeed ? POSTS_PREFETCH_BUDGET_MS : postsPrefetchBudgetMs(isSignedIn);
  let initialPosts = null;
  let raceWon = false;
  let seedUsed = false;
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const postsPromise = getAccountPostsCached(query, username, observer);
    const raced = await Promise.race([
      postsPromise,
      new Promise<typeof BUDGET_EXPIRED>((resolve) => {
        budgetTimer = setTimeout(() => resolve(BUDGET_EXPIRED), budgetMs);
      })
    ]);
    if (raced === BUDGET_EXPIRED) {
      initialPosts = null;
    } else {
      raceWon = true;
      initialPosts = raced ?? null;
    }
    timer.mark('posts');
    // The loser of the race above is never abandoned -- see this file's budget
    // comment for why it keeps running and why its eventual rejection must be
    // swallowed here.
    void postsPromise.catch(() => undefined);
    // Resolve Lumen identities before this reaches the browser, so a lite post
    // never renders under the shared publishing account and then corrects itself.
    if (initialPosts) await attachLiteIdentities(initialPosts);
    timer.mark('attach');
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
      // `viewerSession` is the single read hoisted to the top of this component.
      const blockedKeys = await viewerBlockedKeySet(viewerSession?.user).catch(
        () => new Set<string>()
      );
      if (blockedKeys.size > 0) {
        initialPosts = await filterBlockedForViewer(initialPosts, blockedKeys);
      }
      timer.mark('block');
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
      timer.mark('merge');
      // ★ TRIM THE SEED TO WHAT A CARD SHOWS (snappiness phase 3, 2026-09-03).
      // getAccountPosts returns full bodies and full vote lists; a profile card
      // needs only a plaintext dek and the viewer's own vote. Untrimmed this
      // seed measured ~870 KB per profile (77% vote lists, 18% bodies); trimmed
      // ~127 KB. Same helper the feed uses (lib/feed/seed-trim.ts).
      initialPosts = trimEntriesForSeed(initialPosts, viewerSession?.user?.username ?? '');
      timer.mark('trim');
    }
  } catch (error) {
    logger.error(error, 'Error in PostsPage:');
  } finally {
    // ★ THE LOSING TIMER IS CLEARED (2026-09-05, review). A WON race used to
    // leave a live `setTimeout` running for the remainder of the budget; at
    // 3.5s that is a handle holding the event loop open, and on SIGTERM it can
    // delay the worker's exit by up to that long on every in-flight profile.
    // `finally`, not the happy path, so a rejected upstream clears it as well.
    if (budgetTimer !== undefined) clearTimeout(budgetTimer);
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
    // `anonSeed` is the read taken before the race (null for a signed-in
    // reader, so the "never seed a session from the shared cache" rule above
    // still holds without a second check).
    if (anonSeed && anonSeed.length > 0) {
      initialPosts = anonSeed;
      seedUsed = true;
    }
    timer.mark('seed');
  }
  // `count`, NOT `posts`: `posts` is already the name of the RACE STAGE on this
  // same line, and two `posts=` keys (one ms, one a bare count) make the line
  // ambiguous to read and to grep.
  timer.done({
    user: username,
    anon: String(!isSignedIn),
    budget: budgetMs,
    race: raceWon ? 'won' : 'lost',
    seed: seedUsed ? 'hit' : 'miss',
    count: initialPosts?.length ?? 0
  });
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
