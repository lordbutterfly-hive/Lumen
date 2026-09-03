import { getAccountPosts } from '@transaction/lib/bridge-api';
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

const logger = getLogger('app');

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
    initialPosts = (await getAccountPosts(query, username, observer, '', '')) ?? null;
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
