import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isValidTagFormat, isCommunityFormat } from '@transaction/lib/validation';
import TopicShell from '@/blog/features/discovery-feed/topic-shell';
import { TopicSeedProvider } from '@/blog/features/discovery-feed/topic-seed-context';
import { anonymousTopicSeed } from '@/blog/lib/feed/topic-cache';
import { getServerSessionUser } from '@/blog/lib/server-session';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { viewerBlockedKeySet, filterBlockedForViewer } from '@/blog/lib/lite/social/block-filter';

/**
 * A topic, rendered as the Lumen feed.
 *
 * ★ WHY THIS ROUTE EXISTS OUTSIDE `(main-and-community)` (2026-08-07). Topics
 * used to live at `/trending/<tag>` inside that route group, whose layout wraps
 * every child in the inherited denser shell — a second navigation column and a
 * communities list. Rendering the Lumen feed INSIDE that layout still left the
 * old chrome around it, so the page remained visibly the old product. A route
 * group's layout cannot be opted out of; the only way out is to not be in it.
 *
 * `/trending/<tag>` now redirects here for plain tags, and keeps the community
 * layout for `hive-12345` ids, which genuinely need it (moderators, roles,
 * subscribe).
 */
export function generateMetadata({ params }: { params: { tag: string } }): Metadata {
  const tag = decodeURIComponent(params.tag);
  return {
    title: `#${tag}`,
    description: `Posts about ${tag} on Lumen, ranked for you.`
  };
}

/**
 * ★★ SEEDED FROM THE SERVER'S OWN TOPIC CACHE (snappiness phase 4, 2026-09-03).
 * TopicShell used to fetch its first page only after hydration, so a direct
 * load painted a spinner for ~3 s and a click from the right rail needed a
 * second round trip after the route payload (measured: 0.8-0.9 s to the first
 * card). The API route keeps every topic it served for five minutes; the page
 * now reads that cache (lib/feed/topic-cache.ts) and hands the first page to
 * the shell as initialData, the way home is seeded. Anonymous readers only:
 * a signed-in answer also carries the reader's block list and votes, which
 * only the route applies, and their click is covered by the hover prefetch.
 * A cold topic seeds nothing and behaves exactly as before.
 */
const Page = async ({ params }: { params: { tag: string } }) => {
  const tag = decodeURIComponent(params.tag).toLowerCase();
  // Community ids arrive here too — they are shown as tags, never as pages.
  if (!isValidTagFormat(tag) && !isCommunityFormat(tag)) notFound();
  // ★★★ SEED SIGNED-IN READERS TOO (2026-09-03). A signed-out topic is seeded
  // from the newest-posts fallback memo and paints instantly; a signed-in reader
  // used to get NO seed and waited on the ranked cold-build, measured at
  // 5.7-10 s for the FIRST topic of a session (route note; every later topic is
  // instant once the viewer state is warm). That 10 s is the owner-reported lag.
  // Now a signed-in reader is seeded with the SAME fast newest-posts fallback,
  // block-filtered so nothing they blocked can flash, and TopicShell's
  // refetch-on-mount fetches the ranked feed and swaps it in when the build
  // finishes (masthead goes "newest first" -> "ranked for you"). Content in
  // under a second either way; a cold tag with no warm memo seeds nothing, i.e.
  // exactly today's behaviour, no regression.
  const { isLoggedIn } = await getServerSessionUser();
  let seed = anonymousTopicSeed(tag);
  if (seed && isLoggedIn) {
    try {
      // ★ Bounded: viewerBlockedKeySet can make a cold Hive call (chain mutes);
      // it is warm after any prior feed read (the usual home->topic path), but a
      // direct first-of-session /topics load must not wait on Hive for the seed.
      // Race a short deadline; on timeout seed unfiltered and let the ranked
      // refetch (refetchOnMount:'always') apply the full filter. Found in review.
      const blockedKeys = await Promise.race([
        viewerBlockedKeySet((await getLiteSession()).user),
        new Promise<Set<string>>((resolve) => setTimeout(() => resolve(new Set<string>()), 500))
      ]);
      if (blockedKeys.size > 0) {
        const entries = await filterBlockedForViewer(seed.page.entries, blockedKeys);
        seed = { ...seed, page: { ...seed.page, entries } };
      }
    } catch {
      // Block lookup failed (DB hiccup): show the unfiltered fallback for the
      // second before the ranked feed replaces it, rather than a 10 s wait.
    }
  }
  return (
    <TopicSeedProvider value={seed}>
      <TopicShell tag={tag} />
    </TopicSeedProvider>
  );
};

export default Page;
