import PostContent from './content';
import { getPostCached } from '@/blog/lib/cached-api';
import { liteChainCoordinates, liteRecordExists } from '@/blog/lib/lite/render/lite-entry';
import { attachLiteIdentities, attachLiteIdentitiesToDiscussion } from '@/blog/lib/lite/render/attach-lite';
import { applyOwnerBlocksToDiscussion } from '@/blog/lib/lite/social/block-filter';
import { liteEntryForPermlinkCached } from '@/blog/lib/lite/render/lite-entry-cached';
import { isLumenPermlink } from '@/blog/lib/lite/render/lite-post-id';
import { getCommunity, getDiscussion, getFollowList } from '@transaction/lib/bridge-api';
import { getObserverFromCookies } from '@/blog/lib/auth-utils';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { isUsernameValid, isPermlinkValid, isValidUserParam } from '@/blog/utils/validate-links';
import { notFound } from 'next/navigation';
import { getLogger } from '@ui/lib/logging';
import { isCommunity } from '@ui/lib/utils';
import { DEFAULT_OBSERVER } from '@/blog/lib/utils';
import {
  ObserverProvider,
  InitialPostDataProvider,
  InitialDiscussionProvider,
  InitialCommunityProvider,
  InitialFollowListProvider
} from '@/blog/components/observer-provider';

const logger = getLogger('app');

const PostPage = async ({
  params: { param, p2, permlink },
  searchParams
}: {
  params: { param: string; p2: string; permlink: string };
  searchParams: { [key: string]: string | string[] | undefined };
}) => {
  if (!isValidUserParam(p2)) notFound();

  const username = p2.replace('%40', '').replace('@', '');
  const community = param;
  const validUser = await isUsernameValid(username);
  if (!validUser) notFound();
  if (!isPermlinkValid(permlink)) notFound();

  const observer = await getObserverFromCookies();
  // Who is looking, for the one case it changes the answer: a moderator-limited post is
  // still served to its own author.
  const viewerUserId = (await getLiteSession()).user?.userId;

  const isLoggedIn = observer !== DEFAULT_OBSERVER;

  let postData = null;
  let discussionData = null;
  let communityData = null;
  let mutedListData = null;

  try {
    // Fetch post, discussion, and optionally community in parallel.
    // ActiveVotes and rolesList are secondary — fetched client-side only.
    const [postResult, discussionResult, mutedListResult, communityResult] = await Promise.allSettled([
      // Use cached version — deduplicated with layout's generateMetadata within the same request
      getPostCached(username, permlink, observer),
      getDiscussion(username, permlink, observer),
      // Prefetch the user's muted list so comments are filtered from the first render
      isLoggedIn ? getFollowList(observer, 'muted') : Promise.resolve(null),
      isCommunity(community) ? getCommunity(community, observer) : Promise.resolve(null)
    ]);

    postData = postResult.status === 'fulfilled' ? (postResult.value ?? null) : null;

    // Lumen lite post resolution. Hivemind has nothing under a lite display name (it
    // is not a Hive account), and a lite post's real on-chain author is the shared
    // publishing account. The permlink identifies the post on its own, so resolve from
    // that — never from the author segment.
    //
    // ★ FOR A LUMEN PERMLINK THIS WINS OVER THE CHAIN RESULT, and that ordering is the
    // whole point. A lite handle is by construction a name that was FREE on Hive when
    // the user picked it, so anyone can register it, publish a comment under the same
    // permlink, and have `getPostCached(<handle>, <permlink>)` succeed — serving their
    // content, title and share preview at the victim's own Lumen URL, on every link
    // Lumen itself generates. Our own record decides what a Lumen permlink means.
    if (isLumenPermlink(permlink)) {
      const lite = await liteEntryForPermlinkCached(permlink, observer, viewerUserId);
      if (lite) {
        postData = lite;
      } else if (await liteRecordExists(permlink)) {
        // Ours, and withheld (deleted or moderated). Falling back to the chain here
        // would serve whatever is published at `/@<handle>/<permlink>` — and that handle
        // is a name anyone could have registered.
        notFound();
      }
    } else if (!postData) {
      postData = await liteEntryForPermlinkCached(permlink, observer, viewerUserId);
    }
    if (postResult.status === 'rejected') {
      logger.error(postResult.reason, 'Error fetching post data:');
    }

    // Reached by the URL every OTHER Hive front end links: `/@<sharedAccount>/<permlink>`,
    // the real on-chain coordinates. `getPostCached` succeeds there, so the fallback
    // above never runs and the entry arrives raw — the shared account's name and
    // Hivemind's synthesised "RE: …" title. Resolve it here so the canonical page is
    // right on first paint too. `liteEntryForPost` already sets `_lite` on the pretty-URL
    // path, so this is skipped whenever that ran.
    if (postData && !postData._lite) await attachLiteIdentities([postData]);

    discussionData = discussionResult.status === 'fulfilled' ? (discussionResult.value ?? null) : null;

    // Same problem as the post itself, one level down: the discussion was fetched
    // under the URL's author, which for a lite post is a display name Hivemind has
    // never heard of — so every reply under a lite post was invisible. Retry with the
    // post's REAL on-chain coordinates.
    if (!discussionData) {
      const chain = await liteChainCoordinates(permlink);
      if (chain) {
        discussionData = await getDiscussion(chain.author, chain.permlink, observer).catch(() => null);
      }
    }
    if (discussionResult.status === 'rejected') {
      logger.error(discussionResult.reason, 'Error fetching discussion data:');
    }

    // Every reply written through Lumen is signed by the shared publishing account,
    // so an un-resolved thread shows that one name against everybody's words until
    // the client corrects each comment individually. Resolve the whole thread here,
    // in two queries, before it is serialised.
    discussionData = await attachLiteIdentitiesToDiscussion(discussionData);

    // ★★★ EFFECT (B) — A BLOCKED ACCOUNT'S REPLIES UNDER THIS THREAD ARE NOT SERVED
    // TO ANYBODY, and that includes the server-rendered HTML.
    //
    // Applied AFTER `attachLiteIdentities` on purpose: that is what puts the real
    // writer's `_lite.userId` on each entry, and without it a Lumen reply looks
    // authored by the shared publishing account — so the filter would either miss
    // every lite commenter or hide all of them at once.
    //
    // The same filter runs again in `/api/discussion`, which is what the browser
    // re-fetches this thread through. Both are needed: this one decides the first
    // paint (and what a crawler or a JS-less reader gets), that one decides every
    // subsequent read.
    discussionData = await applyOwnerBlocksToDiscussion(discussionData);
    if (isLoggedIn) {
      mutedListData = mutedListResult.status === 'fulfilled' ? (mutedListResult.value ?? null) : null;
      if (mutedListResult.status === 'rejected') {
        logger.error(mutedListResult.reason, 'Error fetching muted list:');
      }
    }

    if (isCommunity(community)) {
      communityData = communityResult.status === 'fulfilled' ? (communityResult.value ?? null) : null;
      if (communityResult.status === 'rejected') {
        logger.error(communityResult.reason, 'Error fetching community data:');
      }
    }
  } catch (error) {
    logger.error(error, 'Error in PostPage:');
  }

  // Skip 404 when navigating from post creation — the client has optimistic data
  // in React Query cache that will render while Hivemind indexes the post.
  if (!postData && !searchParams?.pending) notFound();

  // Pass data directly via context instead of Hydrate/dehydrate.
  // React Query v4's <Hydrate> has compatibility issues with Next.js App Router
  // streaming SSR where dehydrated state doesn't reliably reach the browser
  // query client, causing unnecessary client-side refetches and spinners.
  return (
    <ObserverProvider value={observer}>
      <InitialPostDataProvider value={postData}>
        <InitialDiscussionProvider value={discussionData}>
          <InitialCommunityProvider value={communityData}>
            <InitialFollowListProvider value={mutedListData}>
              <PostContent />
            </InitialFollowListProvider>
          </InitialCommunityProvider>
        </InitialDiscussionProvider>
      </InitialPostDataProvider>
    </ObserverProvider>
  );
};
export default PostPage;
