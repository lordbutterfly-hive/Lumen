'use client';

import { isNsfwPost, useNsfwPreference } from '@/blog/lib/nsfw';
import BasePathLink from '@/blog/components/base-path-link';
import PageShell from '@/blog/features/layouts/page-shell';
import DialogLogin from '@/blog/components/dialog-login';
import { useFollowListQuery } from '@/blog/components/hooks/use-follow-list';
import { usePinMutation, useUnpinMutation } from '@/blog/components/hooks/use-pin-mutations';
import NoDataError from '@/blog/components/no-data-error';
import OptimisticStatusBanner from '@/blog/components/optimistic-status-banner';
import PendingIndexingMessage from '@/blog/components/pending-indexing-message';
import ChangeTitleDialog from '@/blog/features/community-profile/change-title-dialog';
import DetailsCardHover from '@/blog/features/list-of-posts/details-card-hover';
import ReblogTrigger from '@/blog/features/list-of-posts/reblog-trigger';
import { useRebloggedByQuery } from '@/blog/features/list-of-posts/hooks/use-reblogged-by-query';
import { useDeletePostMutation } from '@/blog/features/post-editor/hooks/use-post-mutation';
import PostForm from '@/blog/features/post-editor/post-form';
import PostingLoader from '@/blog/features/post-editor/posting-loader';
import { ReplyTextbox } from '@/blog/features/post-editor/reply-textbox';
import { AlertDialogFlag } from '@/blog/features/post-rendering/alert-window-flag';
import CommentsSection from '@/blog/features/post-rendering/comments-section';
import ContextLinks from '@/blog/features/post-rendering/context-links';
import DetailsCardVoters from '@/blog/features/post-rendering/details-card-voters';
import FlagIcon from '@/blog/features/post-rendering/flag-icon';
import MutePostDialog from '@/blog/features/post-rendering/mute-post-dialog';
import PostBodySection from '@/blog/features/post-rendering/post-body-section';
import { PostDeleteDialog } from '@/blog/features/post-rendering/post-delete-dialog';
import { SharePost } from '@/blog/features/post-rendering/share-post-dialog';
import FacebookShare from '@/blog/features/post-rendering/share-post-facebook';
import LinkedInShare from '@/blog/features/post-rendering/share-post-linkedin';
import RedditShare from '@/blog/features/post-rendering/share-post-reddit';
import TwitterShare from '@/blog/features/post-rendering/share-post-twitter';
import UserInfo from '@/blog/features/post-rendering/user-info';
import ButtonsContainer from '@/blog/features/mute-follow/buttons-container';
import { useFollowingInfiniteQuery } from '@/blog/features/account-lists/hooks/use-following-infinitequery';
import { UserPopoverCard } from '@/blog/features/post-rendering/user-popover-card';
import { useLiteOverlay } from '@/blog/lib/lite/client/use-lite-overlay';
import AnimatedList from '@/blog/features/suggestions-posts/animated-tab';
import SuggestionsList from '@/blog/features/suggestions-posts/list';
import { useTranslation } from '@/blog/i18n/client';
import { postContainerClasses } from '@/blog/lib/post-layout-classes';
import sorter, { SortOrder } from '@/blog/lib/sorter';
import { DEFAULT_OBSERVER, chainObserver } from '@/blog/lib/utils';
import { getBasePath } from '@ui/lib/path-utils';
import { useQuery } from '@tanstack/react-query';
import { fetchCommunity, fetchCommunityRoles, fetchPost, fetchPostStatus } from '@/blog/lib/chain-fetch';
import { fetchDiscussion } from '@/blog/lib/lite/client/discussion-fetch';
import { isBlockedEntry, useLumenBlockList } from '@/blog/lib/lite/client/use-lumen-block';
import { fetchLiteEntryByPermlink } from '@/blog/lib/lite/client/lite-post-fetch';
import { fetchLiteEngagement } from '@/blog/lib/lite/client/lite-engagement';
import { Entry } from '@hive/common-hiveio-packages/wax';
import { fetchActiveVotes } from '@/blog/lib/chain-fetch';
import { getSimilarPostsByPost, getHiveSenseStatus, isPostStub } from '@transaction/lib/hivesense-api';
import { Badge } from '@ui/components/badge';
import { Button } from '@ui/components/button';
import { Icons } from '@ui/components/icons';
import Loading from '@ui/components/loading';
import TimeAgo from '@ui/components/time-ago';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@ui/components/tooltip';
import dmcaList from '@ui/config/lists/dmca-list';
import dmcaUserList from '@ui/config/lists/dmca-user-list';
import gdprUserList from '@ui/config/lists/gdpr-user-list';
import userIllegalContent from '@ui/config/lists/user-illegal-content';
import { handleError } from '@ui/lib/handle-error';
import { getLogger } from '@ui/lib/logging';
import parseDate from '@ui/lib/parse-date';
import { buildSafePath } from '@ui/lib/sanitize-url';
import { Clock, Link2 } from 'lucide-react';
import { Link } from '@hive/ui';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CircleSpinner } from 'react-spinners-kit';
import { useStorageWithTTL } from '@ui/hooks/useStorageWithTTL';
import { StorageTTL } from '@ui/lib/storage-with-ttl';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import VotesComponentWrapper from '@/blog/features/votes/votes-component-wrapper';
import { isCommunity } from '@ui/lib/utils';
import {
  useSSRObserver,
  useInitialPostData,
  useInitialDiscussion,
  useInitialCommunity,
  useInitialFollowList
} from '@/blog/components/observer-provider';
import { StaleTime } from '@/blog/lib/react-query';

// Maximum number of comments per page
const MAX_COMMENTS_PER_PAGE = 50;

const logger = getLogger('app');

const PostContent = () => {
  const searchParams = useSearchParams();
  const params = useParams<{ param: string; p2: string; permlink: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const commentSort = searchParams?.get('sort') || 'trending';
  const author = params?.p2.replace('%40', '') ?? '';
  const category = params?.param ?? '';
  const permlink = params?.permlink ?? '';
  const { user, isHydrated } = useUserClient();
  /**
   * ★ SAME BUG CLASS AS app-header.tsx ("NEVER SHOW A SIGNED-IN READER A
   * SIGNED-OUT HEADER", 2026-08-10, N-3). `user.isLoggedIn`/`user.username`
   * cannot answer during SSR and report signed-out/empty on the client until
   * `/api/users/me` returns, so any RENDER gate read straight off `user`
   * flickers a signed-in reader into the signed-out variant for that window.
   * `identity` prefers the client's real answer once it has landed and falls
   * back to the cookie the server already read before then.
   *
   * Fixed on this pass (2026-08-11): the AlertDialogFlag trigger, the
   * `viewerIsAuthor` ownership gate (and the PostDeleteDialog block that
   * depends on it), `postFollowTarget`, and the footer Reply/DialogLogin
   * branch. The comment PAGINATION block below is explicitly OFF LIMITS and
   * untouched. `PostDeleteDialog`'s own internal `user.isLoggedIn` check
   * (post-delete-dialog.tsx) is a separate file/hook call, still raw — same
   * accepted residual as the AlertDialogFlag dialog above it: in the narrow
   * window where the SSR-cookie fallback says logged-in but the raw query
   * hasn't answered yet, the dialog can mount with its own OK/confirm button
   * briefly absent, self-healing the moment the client answers land.
   */
  const identity = useSessionIdentity();
  const ssrObserver = useSSRObserver();
  const initialPostData = useInitialPostData();
  const initialDiscussion = useInitialDiscussion();
  const initialCommunity = useInitialCommunity();
  const initialMutedList = useInitialFollowList();
  // Use SSR observer before hydration to match prefetched cache keys,
  // then switch to client observer (which should be the same value for logged-in users)
  const clientObserver = chainObserver(user);
  const observer = isHydrated ? clientObserver : ssrObserver;
  // Use empty key when user is not logged in to disable storage hooks
  const replyStorageId = user.username ? `replybox-/${author}/${permlink}-${user.username}` : '';
  const editStorageId = user.username ? `editbox-/${author}/${permlink}-${user.username}` : '';

  const { t } = useTranslation('common_blog');
  // Reply box state and drafts expire after 30 days
  // Empty key disables the hook entirely, preventing garbage entries
  const [storedReply, storeReply, removeReply] = useStorageWithTTL<boolean>(replyStorageId, false, StorageTTL.UI_STATE);
  const [storedEdit, storeEdit, removeEdit] = useStorageWithTTL<boolean>(editStorageId, false, StorageTTL.UI_STATE);
  const [storedComment] = useStorageWithTTL<string>(
    user.username ? `replyTo-/${author}/${permlink}-${user.username}` : '',
    '',
    StorageTTL.DRAFT
  );

  // Use stored values directly - no useState needed
  // This ensures proper hydration and cross-tab sync
  const reply = storedReply;
  const setReply = useCallback(
    (value: boolean) => {
      if (value) {
        storeReply(true);
      } else {
        removeReply();
      }
    },
    [storeReply, removeReply]
  );

  const edit = storedEdit;
  const setEdit = useCallback(
    (value: boolean | ((prev: boolean) => boolean)) => {
      const newValue = typeof value === 'function' ? value(storedEdit) : value;
      if (newValue) {
        storeEdit(true);
      } else {
        removeEdit();
      }
    },
    [storedEdit, storeEdit, removeEdit]
  );

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [commentsPage, setCommentsPage] = useState(1);
  const postInCommunity = isCommunity(category);
  const { data: postData, isLoading: postIsLoading } = useQuery({
    queryKey: ['postData', author, permlink, observer],
    // Lumen lite posts are not fetchable by their display name (it is not a Hive
    // account), so fall back to resolving by permlink through our own API.
    //
    // ★ THROUGH OUR SERVER, NOT THE CHAIN CLIENT (2026-08-12). This called
    // `getPost` directly (`getChain()`, `wax.common.wasm`) — the sibling
    // `crossPostData` query below already made this exact fix, but noted this
    // query as out of scope because `initialData` protects its FIRST render.
    // It does not protect a later one: `staleTime: MEDIUM` (2 min) expiring
    // while the reader is still on the page, a window refocus, or the
    // SSR-observer-race key change `communityData` (further down) is already
    // documented for all still ran `getPost` from the browser. Same route as
    // `crossPostData`: `apps/blog/app/api/post-status/route.ts`.
    queryFn: async () => {
      const fromChain = await fetchPost(author, permlink, observer).catch(() => null);
      const base = fromChain ?? ((await fetchLiteEntryByPermlink(permlink)) as typeof fromChain);
      if (!base) return base;

      // ★ COUNT THE LUMEN VOTES TOO (2026-08-08).
      //
      // A Lumen ("lite") vote never reaches the chain — many readers share one
      // publisher account, so on-chain they would collapse into a single voter.
      // The chain's `total_votes` therefore cannot include them, and this page
      // showed the chain number alone: a reader upvoted, watched the count go up,
      // reloaded, and watched their own vote disappear. The feed was taught to
      // merge these; this page was not, so the two disagreed about the same post.
      //
      // Copied, never mutated: `getPost` results are shared cache objects, and
      // adding to them in place made counts CLIMB on every reload (measured
      // 2,2,2,2,4 before that was caught in the feed).
      try {
        const local = await fetchLiteEngagement(base.author, base.permlink);
        if (local.voteCount > 0 || local.reblogCount > 0) {
          return {
            ...base,
            reblogs: (base.reblogs ?? 0) + local.reblogCount,
            stats: base.stats
              ? { ...base.stats, total_votes: (base.stats.total_votes ?? 0) + local.voteCount }
              : base.stats
          };
        }
      } catch {
        // A missing Lumen tally leaves the chain numbers standing — incomplete,
        // never blank.
      }
      return base;
    },
    enabled: !!author && !!permlink,
    initialData: initialPostData ?? undefined,
    initialDataUpdatedAt: initialPostData ? Date.now() : undefined,
    staleTime: StaleTime.MEDIUM,
    onError: (error) => {
      handleError(error, { method: 'getPost', params: { author, permlink, observer } });
    }
  });
  // On this page `postData.author` has ALREADY been replaced with the Lumen identity
  // (server-side, in render/lite-entry.ts) — which is right for reading and wrong for
  // acting: a lite name is not a Hive account, so pointing Follow/Mute at it either
  // does nothing or hits an unrelated real user who happens to share the handle. The
  // overlay hands back the account that actually signed the post.
  const litePost = useLiteOverlay(postData);
  // "Is this my post?" has to hold on BOTH addresses a Lumen post has. On the Lumen
  // URL `postData.author` is already the lite identity and the plain comparison
  // works; on the RAW on-chain URL (`/@<publishing account>/<permlink>` — what every
  // other Hive front end links) it is the shared publishing account, so the author
  // saw no Edit or Delete button on their own post. The overlay carries the Lumen
  // identity on both, so compare against that too.
  const viewerIsAuthor = Boolean(
    identity.isLoggedIn && (postData?.author === identity.username || litePost?.author === identity.username)
  );
  const [mutedPost, setMutedPost] = useState<boolean>(postData?.stats?.gray || false);
  // ★ NSFW gate for the post page itself (2026-08-09) — see post-body-section.tsx.
  // Same detector and same preference the feed card uses, so one setting governs
  // the card and the page it links to.
  const nsfwPreference = useNsfwPreference();
  const [nsfwRevealed, setNsfwRevealed] = useState(false);
  const postIsNsfw = postData ? isNsfwPost(postData) : false;
  const nsfwHidden = postIsNsfw && nsfwPreference !== 'show' && !nsfwRevealed;
  // Single reblog query shared by header and footer ReblogTrigger components
  // Same key as the reblog operation below (the real signer), or the button's state
  // would be read under one identity and written under another.
  const { data: isReblogged } = useRebloggedByQuery(
    litePost?.chainAuthor || postData?.author || '',
    postData?.permlink ?? '',
    user.username
  );
  const userFromGDPR = gdprUserList.some((e) => e === postData?.author);

  const crossedPost = Array.isArray(postData?.json_metadata?.tags) && postData.json_metadata.tags.includes('cross-post');
  const legalBlockedUser = userIllegalContent.some((e) => e === postData?.author);
  const copyRightCheck = dmcaList.includes(pathname ?? '');
  // ★ THROUGH OUR SERVER, NOT THE CHAIN CLIENT (2026-08-12). This called
  // `getPost` directly for the cross-post source — unlike the main `postData`
  // query above (SSR `initialData`, `staleTime: MEDIUM`), this one has
  // neither, so it downloaded `wax.common.wasm` every time it ran, for any
  // visitor reading a cross-posted article. See
  // `apps/blog/app/api/post-status/route.ts`.
  const { data: crossPostData } = useQuery({
    queryKey: [
      'postData',
      postData?.json_metadata.original_author,
      postData?.json_metadata.original_permlink,
      observer
    ],
    queryFn: async () => {
      // `getPost` (the direct call this replaced) defaulted both to `''`;
      // matched here since `fetchPostStatus` takes plain `string` params.
      const status = await fetchPostStatus(
        postData?.json_metadata.original_author ?? '',
        postData?.json_metadata.original_permlink ?? '',
        observer
      );
      return status.post as typeof postData;
    },
    enabled: crossedPost
  });

  /**
   * ★ ASK WHETHER THE SERVICE EXISTS BEFORE ASKING IT FOR ANYTHING.
   *
   * "Similar posts" comes from Hivesense, an OPTIONAL extension that the
   * configured node does not have — so the browser fired a cross-origin request
   * at `api.hive.blog/hivesense-api/...` on EVERY post and comment page, got a
   * CORS rejection, retried, and rendered nothing. Three separate UX testers
   * reported the console noise; the widget itself has never worked here.
   *
   * The availability probe is already cached app-wide (`getHiveSenseStatus`,
   * `refetchOnMount: false`), so gating on it costs one shared request instead
   * of two or three per page — and the moment a node DOES offer Hivesense, the
   * feature lights up with no further change.
   */
  const { data: hiveSenseAvailable } = useQuery({
    queryKey: ['hivesense-api'],
    queryFn: () => getHiveSenseStatus(),
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    staleTime: Infinity
  });

  const { data: suggestionData } = useQuery({
    enabled: hiveSenseAvailable === true,
    queryKey: ['suggestions', author, permlink, observer],
    queryFn: async () => {
      const results = await getSimilarPostsByPost({
        author,
        permlink,
        observer,
        result_limit: 10, // Only get 10 suggestions
        full_posts: 10 // Get all as full posts
      });

      if (!results) return null;

      // Filter out null/invalid posts and only include full Entry objects (not stubs).
      // ★ WAS ALSO requiring `(post as Entry).post_id` — dropped every real result.
      // The live Hivesense REST response never sends `post_id` (verified 2026-08-11,
      // 0 of 23 entries checked across similar/by-ids), even though it's typed as a
      // required field on `Entry`. `isPostStub` already does the real, honest check
      // (does the entry actually carry title/body), so the redundant truthiness test
      // on a field the API doesn't send is gone.
      const fullPosts = results.filter((post) => post && !isPostStub(post)) as Entry[];
      return fullPosts;
    }
  });
  const communityObserverMatchesSSR = observer === ssrObserver;
  const useCommunityInitialData = initialCommunity && communityObserverMatchesSSR;
  // ★ THROUGH OUR SERVER, NOT THE CHAIN CLIENT (2026-08-12). `initialData`
  // below only covers first load while the client observer still matches
  // SSR's — the moment a signed-in reader's identity resolves post-hydration
  // (routine, on nearly every load — see `server-session.tsx`), this
  // unconditionally re-fetches via `getChain()`. Every post inside a
  // community, on the highest-traffic page in the app. See
  // `apps/blog/app/api/community/route.ts`.
  const { data: communityData } = useQuery({
    queryKey: ['community', category, observer],
    queryFn: () => fetchCommunity(category, observer),
    enabled: postInCommunity,
    initialData: useCommunityInitialData ? initialCommunity : undefined,
    initialDataUpdatedAt: useCommunityInitialData ? Date.now() : undefined,
    staleTime: StaleTime.LONG,
    onError: (error) => {
      handleError(error, { method: 'getCommunity', params: { category, observer } });
    }
  });

  /**
   * ★★★ A LUMEN POST THAT IS NOT ON CHAIN YET HAS NO CHAIN THREAD AND NO CHAIN
   * VOTES — SO DO NOT ASK FOR THEM.
   *
   * A lite post is published asynchronously by the proxy account. Until that
   * lands, its permlink is our own `lite-<ulid>` and it exists ONLY in Lumen's
   * store. Asking Hivemind for `@<lite name>/lite-<ulid>` therefore returns a
   * real assertion — `Post ... does not exist` — and both queries below routed
   * that straight into `handleError`, which put a red toast carrying a raw
   * `WaxAssertionError` in front of EVERY visitor, signed in or not, for the
   * life of the post. Measured 2026-08-06 by a UX tester, then reproduced: it
   * was still firing on a four-hour-old post, and on an anonymous page load.
   *
   * `lite-` prefixed permlinks are pre-publish by construction (once broadcast,
   * the row carries the real `lumen-<ulid>` chain permlink and these queries are
   * correct again). Reblogs and any other chain lookup on this page should use
   * the same gate.
   */
  const isOnChain = !/^lite-/i.test(permlink);
  // Whose follow button the byline offers: the Lumen identity when this is a
  // Lumen post, the chain author otherwise. Never yourself.
  const postFollowTarget = (() => {
    const target = litePost?.author || crossPostData?.author || postData?.author;
    if (!target || !identity.isLoggedIn) return null;
    return target === identity.username ? null : target;
  })();
  // The viewer's own follow/mute lists, which ButtonsContainer diffs against to
  // decide whether it is showing Follow or Unfollow.
  const postAuthorFollow = useFollowingInfiniteQuery(user.username, 1000, 'blog', ['blog']);
  const postAuthorMute = useFollowingInfiniteQuery(user.username, 1000, 'ignore', ['ignore']);
  // A Lumen-authored post, published or not: its lifecycle is ours, not the
  // chain's payout clock.
  const isLumenPost = !isOnChain || /^lumen-/i.test(permlink);

  const { data: discussionData } = useQuery({
    queryKey: ['discussionData', author, permlink, observer],
    // ★★★ THROUGH OUR SERVER, NOT STRAIGHT TO A HIVE NODE (block effect B).
    // This used to call `getDiscussion` in the browser, so the server-rendered
    // thread could honour a post owner's block and this refetch would put every
    // hidden comment straight back a moment later. `/api/discussion` returns the
    // same map, already filtered. See lib/lite/client/discussion-fetch.ts.
    queryFn: () => fetchDiscussion(author, permlink, observer),
    enabled: isOnChain,
    initialData: initialDiscussion ?? undefined,
    initialDataUpdatedAt: initialDiscussion ? Date.now() : undefined,
    staleTime: StaleTime.MEDIUM,
    onError: (error) => {
      handleError(error, { method: 'getDiscussion', params: { author, permlink, observer } });
    }
  });
  // ★★ LITE REPLIES DO NOT EXIST ON CHAIN YET (2026-08-09, tester NEWCOMER-06).
  //
  // `getDiscussion` is the chain's view, and a lite reply lives in `lumen_post`
  // until the publisher broadcasts it — so a lite reader was told "it will
  // appear in this thread" and then could not find it here, while seeing it
  // perfectly on their own profile. Merged in below so the thread shows what
  // Lumen actually knows, immediately, regardless of the publisher's state
  // (which is stalled on resource credits as this is written).
  const { data: liteReplies } = useQuery({
    queryKey: ['liteReplies', author, permlink],
    queryFn: async (): Promise<Entry[]> => {
      const res = await fetch(
        `/api/lite/posts/replies?author=${encodeURIComponent(author)}&permlink=${encodeURIComponent(permlink)}`
      );
      if (!res.ok) return [];
      const body = (await res.json()) as { entries?: Entry[] };
      return body.entries ?? [];
    },
    staleTime: StaleTime.MEDIUM,
    // A thread must not break because this optional merge failed.
    onError: () => undefined
  });

  // ★ EFFECT (A) IN THE THREAD — "if I block them I never see them", comments
  // included.
  //
  // This is the READER'S OWN half and it is the only half that can live here.
  // `/api/discussion` is deliberately session-less: what it serves is a property of
  // the POST (its owner's blocks), identical for everybody, which is what makes the
  // owner-side promise enforceable and the response cacheable. A reader's personal
  // list is not the post's business and must not change the shared answer — so it is
  // applied on top, here, for this one browser.
  //
  // Removing the entry rather than collapsing it (which is what a chain MUTE does a
  // few lines down in `comment-list-item`) is the difference the owner asked for:
  // blocked means gone, not "click to reveal". Children come off with it for free —
  // `CommentList` descends from rendered parents, so a comment whose parent is not in
  // the list is never reached.
  //
  // ★★★ THAT SUBTREE REMOVAL IS RULED CORRECT — DO NOT "FIX" IT (owner, 2026-08-12).
  //
  // An exploratory QA pass raised it as a defect: blocking one commenter also hides
  // OTHER people's replies nested under them (reproduced on a real thread — 15
  // comments became 13, not 14). Two fixes were offered, re-parenting the orphans to
  // the nearest visible ancestor, or a tombstone. Both were declined.
  //
  // The owner's reasoning, which is the part worth keeping: on Lumen nobody can reply
  // to a comment they cannot see, and a blocked comment is not shown. So a reply
  // sitting under a blocked comment was almost certainly written on ANOTHER Hive
  // frontend (PeakD, Ecency, hive.blog), where the block does not apply. Losing those
  // from this reader's view is an accepted cost, not a bug. A tombstone was declined
  // separately and for the same reason as everywhere else: it is a collapse, and
  // Lumen does not collapse.
  const viewerBlocks = useLumenBlockList(user.isLoggedIn);

  const discussionState = useMemo(() => {
    if (!discussionData) return undefined;
    const list = [...Object.keys(discussionData).map((key) => discussionData[key])]
      .filter((entry) => !isBlockedEntry(entry, viewerBlocks));
    // Union, chain-first: once the publisher lands a reply it arrives from BOTH
    // sources, and the chain copy is the canonical one (it carries real votes
    // and payout). Keyed on author/permlink, which is stable across the move.
    if (liteReplies && liteReplies.length > 0) {
      const seen = new Set(list.map((c) => `${c.author}/${c.permlink}`));
      for (const reply of liteReplies) {
        if (isBlockedEntry(reply, viewerBlocks)) continue;
        if (!seen.has(`${reply.author}/${reply.permlink}`)) list.push(reply);
      }
    }
    const sortType = commentSort as SortOrder;
    sorter(list, sortType);
    return list;
  }, [discussionData, commentSort, liteReplies, viewerBlocks]);

  const paginatedDiscussionState = useMemo(() => {
    if (!discussionState || !postData) return undefined;

    // Build a map of comments by parent_author/parent_permlink for fast lookup
    const commentsByParent = new Map<string, Entry[]>();

    discussionState.forEach((comment) => {
      const parentKey = `${comment.parent_author}/${comment.parent_permlink}`;
      if (!commentsByParent.has(parentKey)) {
        commentsByParent.set(parentKey, []);
      }
      commentsByParent.get(parentKey)!.push(comment);
    });

    // Find all main comments (direct replies to the current post/comment)
    const mainComments = discussionState.filter(
      (comment) =>
        comment.depth === postData.depth + 1 &&
        comment.parent_author === postData.author &&
        comment.parent_permlink === postData.permlink
    );

    // Divide main comments into pages - maximum 50 comments total per page
    //
    // ★ KEYED ON `author/permlink`, NOT `post_id` (2026-08-11).
    //
    // `post_id` is typed as a required `number` on `Entry`
    // (packages/common-hiveio-packages/src/wax/extended-hive.chain.ts), but Hive's
    // `bridge.get_discussion` never actually sends it — confirmed live against
    // api.hive.blog: 0 of 125 entries on a real discussion carry the field, root
    // post and replies alike. Every `comment.post_id` here was `undefined`, so
    // `Set<number>` collapsed every `.add(undefined)` into one entry and
    // `.has(undefined)` matched every comment, silently defeating the 50-per-page
    // cap: the whole thread rendered on "page 1" regardless of size.
    // `${author}/${permlink}` is Hive's real unique identity for a piece of
    // content and is always present, so it is what actually distinguishes entries.
    const mainPost = discussionState.find((c) => c.depth === 0);
    const keyOf = (entry: Entry) => `${entry.author}/${entry.permlink}`;
    const pages: Set<string>[] = [];
    let currentPageIds = new Set<string>();
    let currentPageCount = mainPost ? 1 : 0;

    if (mainPost) {
      currentPageIds.add(keyOf(mainPost));
    }

    const startNewPage = () => {
      pages.push(currentPageIds);
      currentPageIds = new Set<string>();
      currentPageCount = mainPost ? 1 : 0;
      if (mainPost) {
        currentPageIds.add(keyOf(mainPost));
      }
    };

    // ★ EVERY COMMENT MUST LAND ON EXACTLY ONE PAGE (2026-08-11 regression fix).
    //
    // `placedKeys` is scoped to the WHOLE pass — every main comment across every
    // top-level thread, not reset per main comment or per page — so a comment can
    // never be silently re-queued, and (the actual bug) never silently dropped
    // when it is skipped as "already placed" but was never added to any page.
    const placedKeys = new Set<string>();
    if (mainPost) {
      placedKeys.add(keyOf(mainPost));
    }

    // ★★★ A SUBTREE MUST NEVER SPAN TWO PAGES — discovered the hard way, in a
    // real signed-in browser, AFTER a first fix that only satisfied the
    // in-memory Set (2026-08-11).
    //
    // The first attempt at this fix kept a per-mainComment BFS `queue` and, when
    // a page filled mid-subtree, rolled to a new page and kept draining the SAME
    // queue into it — so every descendant ended up in SOME page's `Set<string>`,
    // and the flat "is every key placed" assertion below was satisfied. It
    // still rendered broken: page 2 of a live thread claimed 48 comments in its
    // Set but rendered only 6 `[data-testid="comment-list-item"]` nodes.
    //
    // The reason is `CommentList` (features/post-rendering/comment-list.tsx):
    // it resolves parent -> child by filtering `data.parent_author ===
    // parent.author && data.parent_permlink === parent.permlink` and recurses,
    // where `data` is THIS PAGE's flat `paginatedDiscussionState.comments` —
    // not the full discussion. A descendant is only reachable if its ENTIRE
    // ancestor chain, up to a main comment, is present in that same page's flat
    // list. Splitting a subtree across pages puts a child on page 2 whose
    // parent (the thread's mainComment) rendered on page 1 — page 2 has no node
    // to attach it under, so it renders nowhere. Same failure shape as the bug
    // this whole fix targets, just moved one layer down: complete Set
    // membership is necessary but not sufficient — CommentList also needs
    // membership to be TREE-CONNECTED within a single page.
    //
    // The fix: treat each top-level comment's full subtree (itself + every
    // descendant, however deep) as one atomic, indivisible unit. Compute its
    // REAL size with a full walk — not the old `1 + min(directChildren, 10)`
    // estimate, which is exactly what let pages fill mid-subtree in the first
    // place — and place the whole thing on one page. If it does not fit a
    // fresh page, start a new one first; if it STILL does not fit even a fresh
    // page (a single thread with more than ~49 descendants), let that one page
    // overshoot the 50 cap rather than truncate — a documented, bounded
    // overshoot beats truncation, which is unrenderable by construction (see
    // above) and was the entire bug.
    for (const mainComment of mainComments) {
      const subtree: Entry[] = [];
      const seenInWalk = new Set<string>(); // guards a corrupt/cyclic parent chain
      const walkQueue: Entry[] = [mainComment];
      while (walkQueue.length > 0) {
        const node = walkQueue.shift()!;
        const nodeKey = keyOf(node);
        if (seenInWalk.has(nodeKey)) continue;
        seenInWalk.add(nodeKey);
        subtree.push(node);
        const children = commentsByParent.get(nodeKey) || [];
        walkQueue.push(...children);
      }

      // Roll to a fresh page if this subtree would overflow the current one —
      // but never roll an EMPTY page (nothing but the main post), or an
      // oversized subtree would spin up an endless run of empty pages ahead of
      // it and never actually get placed.
      if (
        currentPageIds.size > (mainPost ? 1 : 0) &&
        currentPageCount + subtree.length > MAX_COMMENTS_PER_PAGE
      ) {
        startNewPage();
      }

      for (const entry of subtree) {
        const entryKey = keyOf(entry);
        if (placedKeys.has(entryKey)) continue; // safety net; see seenInWalk above
        placedKeys.add(entryKey);
        currentPageIds.add(entryKey);
        currentPageCount++;
      }
    }

    if (currentPageIds.size > (mainPost ? 1 : 0)) {
      pages.push(currentPageIds);
    }

    // ★ ASSERT THE INVARIANT, DON'T JUST HOPE FOR IT. Every entry in
    // `discussionState` must be reachable from some page — that is the whole
    // point of the fix above. Log loudly (not throw): a comment thread should
    // degrade to "imperfectly paginated", never crash the entire post page for
    // every reader over a pagination edge case.
    if (discussionState.length !== placedKeys.size) {
      const missing = discussionState.filter((c) => !placedKeys.has(keyOf(c)));
      logger.error(
        { totalEntries: discussionState.length, placed: placedKeys.size, missing: missing.map(keyOf) },
        'paginatedDiscussionState: comment(s) unreachable on any page'
      );
    }

    const totalPages = Math.max(1, pages.length);
    const validPage = Math.min(commentsPage, totalPages);
    const pageIncludedIds = pages[validPage - 1] || new Set<string>();

    // Always include the main post
    if (mainPost && !pageIncludedIds.has(keyOf(mainPost))) {
      pageIncludedIds.add(keyOf(mainPost));
    }

    // Create the final list using Set for O(1) lookup
    const paginatedComments = discussionState.filter((comment) => pageIncludedIds.has(keyOf(comment)));

    return {
      comments: paginatedComments,
      totalPages,
      currentPage: validPage,
      totalMainComments: mainComments.length
    };
  }, [discussionState, postData, commentsPage]);
  const firstPost = discussionState?.find((post) => post.depth === 0);
  const post_is_pinned = firstPost?.stats?.is_pinned ?? false;

  const thisPost = discussionState?.find((post) => post.permlink === permlink && postData?.author === author);
  // Use thisPost.depth if available, fallback to postData.depth (for optimistic posts), default to 0
  const postDepth = thisPost?.depth ?? postData?.depth ?? 0;
  const commentSite = postDepth !== 0;
  const userFromDMCA = dmcaUserList.some((e) => e === postData?.author);

  // ★ THROUGH OUR SERVER, NOT THE CHAIN CLIENT (2026-08-12). Unconditional
  // (no `initialData`) on every community post — the highest-traffic page in
  // the app. See `apps/blog/app/api/community-roles/route.ts`, which also
  // backs `roles/[tag]/content.tsx`'s own, separately-broken instance of this
  // same read (see that file for its own key-mismatch note).
  const { data: userCanModerate } = useQuery({
    queryKey: ['rolesList', category],
    queryFn: () => fetchCommunityRoles(category),
    enabled: postInCommunity,
    onError: (error) => {
      handleError(error, { method: 'getListCommunityRoles', params: { category } });
    },
    select: (data) => {
      const userRole = data?.find((e) => e[0] === user.username);
      const userCanModerate = userRole
        ? userRole[1] === 'mod' || userRole[1] === 'admin' || userRole[1] === 'owner'
        : false;
      return userCanModerate;
    }
  });

  // ★ THROUGH OUR SERVER, NOT THE CHAIN CLIENT (2026-08-12). Unconditional
  // (no `initialData`) for virtually every post — the highest-traffic page
  // in the app, both signed in and out. See
  // `apps/blog/app/api/active-votes/route.ts`.
  const { data: activeVotesData } = useQuery({
    queryKey: ['activeVotes', author, permlink],
    queryFn: () => fetchActiveVotes(author, permlink),
    enabled: isOnChain,
    onError: (error) => {
      handleError(error, { method: 'getActiveVotes', params: { author, permlink } });
    }
  });

  const { data: mutedList, isError: mutedListIsError } = useFollowListQuery(
    user.username,
    'muted',
    initialMutedList,
    user.account_tier !== 'lite'
  );
  /**
   * ★ BUG 1 FIX (2026-08-12, FX3) — the mute-unknown fix that reached
   * `medium-post-card.tsx` (`use-moderation-status.ts`'s `muteStatusUnknown`,
   * fixed today) never reached the comment thread, which reads a SEPARATE
   * fetch of the SAME relationship (`bridge.get_follow_list`, follow_type
   * "muted" — the bridge equivalent of `condenser_api.get_following` type
   * "ignore" `useModerationStatus` reads). `getFollowList` never swallows a
   * genuine failure into a fake empty array (no `.catch(() => [])` anywhere
   * in its path — same property `use-moderation-status.ts`'s own comment
   * verified for the blacklist read), so React Query's retries (3 attempts,
   * backoff) run to completion and `isError` is the honest, exhausted-retry
   * signal.
   *
   * `mutedList || initialMutedList || []` two lines up stays exactly as it
   * was — every OTHER caller of `mutedList` in this file still needs a plain
   * array, and collapsing "loading"/"errored"/"empty" into `[]` there is only
   * a bug when a CONSUMER treats that `[]` as a confirmed-clean answer. This
   * flag is threaded down ALONGSIDE the array (through `CommentsSection` ->
   * `CommentList` -> `CommentListItem`, the same path `mutedList` already
   * takes) so a consumer that DOES gate rendered content on mute status
   * (`comment-list-item.tsx`) can tell "confirmed nobody in this list" apart
   * from "we don't actually know right now" — see that file's own gate for
   * why this is threaded as a flag alongside the prop rather than switching
   * the comment thread onto `useModerationStatus` (a second, divergent read
   * of the same relationship, which an earlier pass explicitly declined to
   * introduce).
   */
  const mutedListUnknown = mutedListIsError;

  const pinMutations = usePinMutation();
  const unpinMutation = useUnpinMutation();

  const pin = async () => {
    try {
      await pinMutations.mutateAsync({ community: category, username: author, permlink });
    } catch (error) {
      handleError(error, { method: 'pin', params: { community: category, username: author, permlink } });
    }
  };
  const unpin = async () => {
    try {
      await unpinMutation.mutateAsync({ community: category, username: author, permlink });
    } catch (error) {
      handleError(error, { method: 'unpin', params: { community: category, username: author, permlink } });
    }
  };

  const deletePostMutation = useDeletePostMutation();
  const basepath = getBasePath();
  const deleteComment = async (permlink: string) => {
    try {
      await deletePostMutation.mutateAsync({ permlink });
      setIsSubmitting(true);
      // Wait 2 seconds before redirecting
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Use window.location for subdirectory deployments to ensure catch-all route works
      if (basepath) {
        // Security: Build path safely to prevent XSS
        // ★ /@author/posts was deleted 2026-08-06; land on the profile itself,
        // which is the redesigned page and already opens on its Posts tab.
        const safePath = buildSafePath(basepath, `/@${author}`);
        if (safePath) {
          window.location.href = safePath;
        } else {
          // Fallback to client navigation if path construction fails
          router.push(`/@${author}`);
        }
      } else {
        // Use client-side navigation for root deployments (faster)
        router.push(`/@${author}`);
      }
    } catch (error) {
      setIsSubmitting(false);
      handleError(error, { method: 'deleteComment', params: { permlink } });
    }
  };

  useEffect(() => {
    setMutedPost(postData?.stats?.gray ?? false);
  }, [postData?.stats?.gray]);

  // Reset comments pagination when the post changes
  useEffect(() => {
    setCommentsPage(1);
  }, [author, permlink]);

  // Stable callback for CommentsSection
  const handleSetCommentsPage = useCallback((page: number | ((prev: number) => number)) => {
    setCommentsPage(page);
  }, []);

  // Stable callback for PostBodySection
  const handleShowMutedContent = useCallback(() => {
    setMutedPost(false);
  }, []);

  const handleShowNsfwContent = useCallback(() => {
    setNsfwRevealed(true);
  }, []);

  /**
   * ★ LAND AT THE TOP OF THE POST (v8, post detail). Next's App Router keeps the
   * previous scroll offset across a client navigation, so opening a post from halfway
   * down the feed dropped the reader into the middle of the article, with no signal
   * that anything above it existed. Keyed on the permlink, so it fires per post and
   * not on every re-render of the same one.
   */
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [author, permlink]);

  const isPending = searchParams?.get('pending') === '1';
  if (userFromGDPR) return <NoDataError />;
  if (!postData && !postIsLoading) {
    if (isPending) return <PendingIndexingMessage author={author} permlink={permlink} observer={observer} />;
    return <NoDataError />;
  }

  return (
    <>
      {/* ★★★ THE CANONICAL APP FRAME, NOT A BESPOKE ONE (F9, 2026-08-11, buildmap
          item 12). This used to be a hand-rolled `grid-cols-12` with no
          `max-w-[1720px]` cap, a proportional (not fixed-200px) left column, and
          an empty `col-span-2` div standing in for a right rail — measured as
          ~236-247px of pure dead space on the right at 1415-1485px viewports,
          while every other reading surface (home, topics, search, creators,
          proposals) got the real 200/1fr/312 frame with a working right rail.
          `PageShell` is that frame, extracted once and reused — see its own doc
          comment for why. The article card itself (`postContainerClasses`) is
          UNCHANGED: it was already `max-w-4xl mx-auto`, so its own width was never
          the problem; only the chrome around it was. The suggestion list keeps its
          previous position, sticky under the nav in the left column. */}
      <PageShell
        mainClassName="min-w-0 py-8 flex flex-col"
        leftRailExtra={suggestionData ? <AnimatedList suggestions={suggestionData} /> : null}
      >
        <div className={postContainerClasses}>
            {crossedPost ? (
              <div className="mb-4 flex items-center gap-2 bg-background-secondary p-5 text-sm">
                <Icons.crossPost className="h-4 w-4" />
                <span>
                  <BasePathLink href={`/@${postData?.author}`} className="font-bold hover:text-destructive">
                    {postData?.author}{' '}
                  </BasePathLink>
                  cross-posted{' '}
                  <Link
                    href={`/@${postData?.json_metadata.original_author}/${postData?.json_metadata.original_permlink}`}
                    className="font-bold hover:text-destructive"
                  >
                    this post{' '}
                  </Link>
                  in{' '}
                  <Link href={`/topics/${postData?.community}`} className="font-bold hover:text-destructive">
                    {postData?.community_title ?? postData?.community}
                  </Link>
                </span>
              </div>
            ) : null}
            {postData ? (
              <div>
                {/* Post Header Section */}
                <div className="mb-5 border-b border-border pb-5">
                  {!commentSite ? (
                    <div className="flex items-start justify-between gap-3">
                      <h1
                        className="font-sanspro text-2xl font-extrabold leading-tight tracking-tight text-foreground sm:text-3xl"
                        data-testid="article-title"
                      >
                        {postData.title}
                        {postData.percent_hbd === 0 && (
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span
                                  className="ml-2 inline-flex items-center align-middle"
                                  data-testid="powered-up-100-trigger"
                                >
                                  <Icons.hive className="h-5 w-5 text-red-500" />
                                </span>
                              </TooltipTrigger>
                              <TooltipContent data-testid="powered-up-100-tooltip">
                                {t('cards.post_card.powered_up_100')}
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        )}
                      </h1>
                      {postInCommunity && (
                        <div className="mt-1 shrink-0 cursor-pointer rounded-full border border-transparent p-1.5 text-muted-foreground transition-colors hover:border-border hover:bg-background-secondary hover:text-destructive">
                          {!identity.isLoggedIn ? (
                            <DialogLogin>
                              <FlagIcon onClick={() => {}} />
                            </DialogLogin>
                          ) : communityData ? (
                            <AlertDialogFlag
                              community={category}
                              username={author}
                              permlink={permlink}
                              flagText={communityData.flag_text}
                            >
                              <FlagIcon onClick={() => {}} />
                            </AlertDialogFlag>
                          ) : null}
                        </div>
                      )}
                    </div>
                  ) : (
                    <ContextLinks
                      data={postData}
                      noContext={!!discussionState && !discussionState.some((e) => e.depth === 1)}
                    />
                  )}
                  {postData._optimistic && (
                    <OptimisticStatusBanner createdAt={postData.created} lite={!isOnChain} />
                  )}
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    {/* ★ FOLLOW THE PERSON YOU JUST READ, WHERE YOU READ THEM.
                        The only follow control lived on the author's PROFILE, one
                        navigation away — so the natural moment ("I liked that,
                        who wrote it?") had nothing to act on. A newcomer walking
                        the ordinary path of open-a-post-then-follow-its-author
                        found no Follow anywhere on the page; the byline offered
                        Reblog and nothing else. Reproduced on three posts.
                        Mute stays off deliberately: this is a reading surface,
                        not a moderation one, and `hideMute` is the same switch
                        the lite-author case already uses. */}
                    <UserInfo
                      permlink={permlink}
                      moderateEnabled={!!userCanModerate}
                      author={crossPostData?.author || litePost?.chainAuthor || postData.author}
                      liteName={crossPostData ? undefined : litePost?.author}
                      author_reputation={
                        crossPostData?.author_reputation ?? postData.author_reputation
                      }
                      author_title={postData.author_title}
                      authored={postData.json_metadata?.author}
                      community_title={
                        // ★ `postData.community_title` was missing from this chain
                        //   while TWO other elements on this same page already used
                        //   it (lines ~546 and ~725) — so the byline rendered empty
                        //   and fell through to its placeholder while the correct
                        //   name, "Splinterlands", sat in the payload it was handed.
                        //   A UX tester spotted the two elements disagreeing about
                        //   the same post. `communityData` is a separate request
                        //   that need not have resolved; the post itself always
                        //   carries this.
                        crossPostData?.community_title ??
                        postData.community_title ??
                        communityData?.title ??
                        ''
                      }
                      community={crossPostData?.community ?? category}
                      category={postData.category}
                      created={postData.created}
                      blacklist={
                        firstPost ? firstPost.blacklists : thisPost ? thisPost.blacklists : postData.blacklists
                      }
                    />
                    {postFollowTarget ? (
                      <ButtonsContainer
                        username={postFollowTarget}
                        user={user}
                        variant="outlineRed"
                        liteTarget={Boolean(litePost?.author)}
                        hideMute
                        follow={postAuthorFollow}
                        mute={postAuthorMute}
                      />
                    ) : null}
                    {/* Reblog Button in Header */}
                    {!commentSite && (
                      <ReblogTrigger
                        author={litePost?.chainAuthor || postData.author}
                        permlink={postData.permlink}
                        dataTestidTooltipContent="post-header-reblog-tooltip"
                        dataTestidTooltipIcon="post-header-reblog-icon"
                        isReblogged={isReblogged}
                        showLabel
                      />
                    )}
                  </div>
                </div>
                {postIsLoading ? (
                  <Loading loading={postIsLoading} />
                ) : edit && commentSite && postData.parent_author && postData.parent_permlink ? (
                  <ReplyTextbox
                    editMode={edit}
                    onSetReply={setEdit}
                    username={postData.parent_author}
                    permlink={postData.permlink}
                    parentPermlink={postData.parent_permlink}
                    storageId={editStorageId}
                    comment={postData}
                    discussionAuthor={author}
                    discussionPermlink={permlink}
                    observer={observer}
                  />
                ) : edit ? (
                  <PostForm
                    username={postData.author}
                    editMode={edit}
                    setEditMode={setEdit}
                    sideBySidePreview={false}
                    post_s={postData}
                    refreshPage={() => {
                      router.replace(pathname || '/');
                    }}
                    setIsSubmitting={setIsSubmitting}
                  />
                ) : legalBlockedUser ? (
                  <div className="px-2 py-6">{t('global.unavailable_for_legal_reasons')}</div>
                ) : copyRightCheck || userFromDMCA ? (
                  <div className="px-2 py-6">{t('post_content.body.copyright')}</div>
                ) : (
                  <PostBodySection
                    body={postData.body}
                    author={postData.author}
                    permlink={postData.permlink}
                    mainPost={postData.depth === 0}
                    crossPostBody={crossPostData?.body}
                    mutedPost={mutedPost}
                    mutedReasons={postData.stats?.muted_reasons}
                    onShowMutedContent={handleShowMutedContent}
                    nsfwHidden={nsfwHidden}
                    onShowNsfwContent={handleShowNsfwContent}
                  />
                )}
                {/* Tags Section */}
                <div className="clear-both mt-6 border-t border-border pt-5">
                  {!commentSite ? (
                    <ul className="flex flex-wrap gap-2" data-testid="hashtags-post">
                      {Array.isArray(postData.json_metadata?.tags) && postData.json_metadata.tags
                        .filter((e) => e !== postData.category && e !== '' && e !== postData.community)
                        .map((tag: string) => (
                          <li key={tag}>
                            <Link
                              href={`/topics/${tag}`}
                              className="inline-block rounded-full border border-border bg-background-secondary px-3 py-1 text-sm font-medium text-muted-foreground transition-all hover:border-destructive hover:bg-destructive/10 hover:text-destructive"
                            >
                              #{tag}
                            </Link>
                          </li>
                        ))}
                    </ul>
                  ) : null}
                </div>
                {/* Post Footer */}
                <div
                  className="mt-5 rounded-lg border border-border bg-background-secondary/20 px-4 py-3 text-sm text-primary"
                  data-testid="author-data-post-footer"
                >
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    {/* Meta info */}
                    <div className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
                      <Clock className="mr-1 h-4 w-4" />
                      <span title={String(parseDate(postData.created))} data-testid="post-footer-timestamp">
                        <TimeAgo date={postData.created} />
                      </span>
                      <span className="mx-1">·</span>
                      <span>{t('post_content.footer.in')}</span>
                      <span className="font-semibold text-destructive">
                        {postData.community_title ? (
                          <Link
                            href={`/topics/${crossPostData?.community ?? postData.community}`}
                            className="hover:underline"
                            data-testid="footer-comment-community-category-link"
                          >
                            {crossPostData?.community_title ?? postData.community_title}
                          </Link>
                        ) : (
                          <Link
                            href={`/topics/${postData.category}`}
                            className="hover:underline"
                            data-testid="footer-comment-community-category-link"
                          >
                            #{postData.category}
                          </Link>
                        )}
                      </span>
                      <span className="mx-1">·</span>
                      <span>{t('post_content.footer.by')}</span>
                      <div className="flex items-center">
                        <UserPopoverCard
                          author={
                            postData.json_metadata.original_author || litePost?.chainAuthor || postData.author
                          }
                          liteName={postData.json_metadata.original_author ? undefined : litePost?.author}
                          author_reputation={crossPostData?.author_reputation ?? postData.author_reputation}
                          blacklist={
                            firstPost
                              ? firstPost.blacklists
                              : thisPost
                                ? thisPost.blacklists
                                : postData.blacklists
                          }
                        />
                        {postData.author_title ? (
                          <Badge variant="outline" className="ml-1 border-destructive text-slate-500">
                            <span className="mr-1">{postData.author_title}</span>
                            <ChangeTitleDialog
                              community={category}
                              moderateEnabled={!!userCanModerate}
                              userOnList={postData.author}
                              title={postData.author_title ?? ''}
                              permlink={permlink}
                            />
                          </Badge>
                        ) : (
                          <ChangeTitleDialog
                            community={category}
                            moderateEnabled={!!userCanModerate}
                            userOnList={postData.author}
                            title={postData.author_title ?? ''}
                            permlink={permlink}
                          />
                        )}
                      </div>
                    </div>
                    {/* Stats */}
                    <div className="flex items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm">
                      {/* The REAL signer: a full Hive user's vote is a chain op, and
                          our own vote table keys on the same value the read path sends.
                          A display name is neither stable (it changes at upgrade) nor a
                          Hive account. `author` here is a key, never display text. */}
                      <VotesComponentWrapper
                        post={{ ...postData, author: litePost?.chainAuthor || postData.author }}
                        type="post"
                      />
                      <span className="h-4 w-px bg-border" />
                      <DetailsCardHover
                        post={postData}
                        decline={parseFloat(postData.max_accepted_payout) === 0}
                        post_page
                      >
                        <span
                          data-testid="comment-payout"
                          className={`font-bold text-destructive hover:cursor-pointer ${
                            parseFloat(postData.max_accepted_payout) === 0
                              ? '!text-gray-600 line-through'
                              : ''
                          }`}
                        >
                          ${postData.payout?.toFixed(2)}
                        </span>
                      </DetailsCardHover>
                      {activeVotesData && !!postData.stats?.total_votes && postData.stats?.total_votes !== 0 ? (
                        <>
                          <span className="h-4 w-px bg-border" />
                          <DetailsCardVoters post={postData}>
                            <span className="font-medium text-destructive">
                              {postData.stats?.total_votes > 1
                                ? t('post_content.footer.votes', { votes: postData.stats?.total_votes })
                                : t('post_content.footer.vote')}
                            </span>
                          </DetailsCardVoters>
                        </>
                      ) : null}
                    </div>
                  </div>
                  {/* Actions Row */}
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2" data-testid="comment-respons-header">
                      <ReblogTrigger
                        author={litePost?.chainAuthor || postData.author}
                        permlink={postData.permlink}
                        dataTestidTooltipContent="post-footer-reblog-tooltip"
                        dataTestidTooltipIcon="post-footer-reblog-icon"
                        isReblogged={isReblogged}
                      />
                      <span className="text-border">|</span>
                      {identity.isLoggedIn ? (
                        <>
                          <button
                            onClick={() => {
                              setReply(!reply);
                            }}
                            className="flex items-center font-medium text-destructive transition-colors hover:text-destructive/80"
                            data-testid="comment-reply"
                          >
                            {t('post_content.footer.reply')}
                          </button>
                          {pinMutations.isLoading || unpinMutation.isLoading ? (
                            <div className="ml-2">
                              <CircleSpinner
                                loading={pinMutations.isLoading || unpinMutation.isLoading}
                                size={18}
                                color="#dc2626"
                              />
                            </div>
                          ) : userCanModerate && postData.depth === 0 ? (
                            <div className="flex flex-col items-center">
                              {/* <button
                            disabled={postData.stats?._temporary}
                            className={clsx('ml-2 flex items-center text-destructive', {
                              'animate-pulse cursor-not-allowed text-destructive':
                                firstPost?.stats?._temporary
                            })}
                            onClick={post_is_pinned ? unpin : pin}
                          >
                            {post_is_pinned ? t('communities.unpin') : t('communities.pin')}
                          </button> */}
                              {/* TODO swap two button to one when api return stats.is_pinned,
                                temprary use two button to unpin and pin
                                */}
                              <button
                                className="ml-2 flex items-center text-destructive"
                                onClick={pin}
                                data-testid="post-pin-button"
                              >
                                {t('communities.pin')}
                              </button>
                              <button
                                className="ml-2 flex items-center text-destructive"
                                onClick={unpin}
                                data-testid="post-unpin-button"
                              >
                                {t('communities.unpin')}
                              </button>
                            </div>
                          ) : null}
                          {userCanModerate ? (
                            <MutePostDialog
                              comment={false}
                              community={category}
                              /* Muting is a chain op: it must name the account that
                                 actually signed the post, not the Lumen display name. */
                              username={litePost?.chainAuthor || postData.author}
                              permlink={postData.permlink}
                              contentMuted={postData.stats?.gray ?? false}
                              discussionPermlink={postData.permlink}
                              discussionAuthor={litePost?.chainAuthor || postData.author}
                              temporaryDisable={postData.stats?._temporary}
                            />
                          ) : null}
                        </>
                      ) : (
                        <DialogLogin>
                          <button className="flex items-center text-destructive" data-testid="comment-reply">
                            {t('post_content.footer.reply')}
                          </button>
                        </DialogLogin>
                      )}
                      {/* ★ THE DELETE CONTROL COULD NEVER APPEAR ON A LUMEN POST.
                          `payout_at` is Hive's cashout time — a real post gets
                          seven days, and this gate means "still editable". A
                          Lumen entry has no cashout, and `dbPostToEntry` sets
                          `payout_at` to the CREATION time, so `now < payout_at`
                          was false one second after posting and the author was
                          left with no way to remove their own post — while
                          `deleteLitePost` sat fully implemented and wired into
                          `useDeletePostMutation`. A tester searched the post
                          page, the profile list, settings and the whole DOM for
                          a delete affordance and correctly reported there was
                          none. The feature existed; the gate hid it. */}
                      {postData.children === 0 &&
                      viewerIsAuthor &&
                      (isLumenPost || new Date() < new Date(`${postData.payout_at}Z`)) ? (
                        <>
                          <span className="mx-1">|</span>
                          <PostDeleteDialog
                            permlink={postData.permlink}
                            action={(permlink) => {
                              deleteComment(permlink);
                            }}
                            label="Post"
                          >
                            <button
                              disabled={edit || deletePostMutation.isLoading}
                              className="flex items-center text-destructive"
                              data-testid="comment-card-footer-delete"
                            >
                              {deletePostMutation.isLoading ? (
                                <CircleSpinner
                                  loading={deletePostMutation.isLoading}
                                  size={18}
                                  color="#dc2626"
                                />
                              ) : (
                                t('cards.comment_card.delete')
                              )}
                            </button>
                          </PostDeleteDialog>
                        </>
                      ) : null}
                      {viewerIsAuthor && !edit ? (
                        <>
                          <span className="mx-1">|</span>
                          <button
                            onClick={() => {
                              setEdit(!edit);
                            }}
                            className="flex items-center text-destructive"
                            data-testid="post-edit"
                          >
                            {t('post_content.footer.edit')}
                          </button>
                        </>
                      ) : null}
                      <span className="text-border">|</span>
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger className="flex items-center" data-testid="comment-respons">
                            <Link href={postData.url} className="flex cursor-pointer items-center text-muted-foreground transition-colors hover:text-foreground">
                              {postData.children > 1 ? (
                                <Icons.messagesSquare className="mr-1 h-4 w-4" />
                              ) : (
                                <Icons.comment className="mr-1 h-4 w-4" />
                              )}
                              <span className="font-medium">{postData.children}</span>
                            </Link>
                          </TooltipTrigger>
                          <TooltipContent data-testid="post-footer-response-tooltip">
                            <p>
                              {postData.children === 0
                                ? t('post_content.footer.no_responses')
                                : postData.children === 1
                                  ? t('post_content.footer.response')
                                  : t('post_content.footer.responses', { responses: postData.children })}
                            </p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </div>
                    {/* Share buttons */}
                    <div className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1">
                      <FacebookShare url={postData.url} />
                      <TwitterShare title={postData.title} url={postData.url} />
                      <LinkedInShare title={postData.title} url={postData.url} />
                      <RedditShare title={postData.title} url={postData.url} />
                      <SharePost path={postData.url} title={postData.title}>
                        <Link2 className="h-[18px] w-[18px] cursor-pointer text-muted-foreground transition-colors hover:text-destructive" data-testid="share-post" />
                      </SharePost>
                    </div>
                  </div>
                </div>
                {reply && postData && user.isLoggedIn ? (
                  <div className="mt-4 px-4">
                    <ReplyTextbox
                      editMode={false}
                      onSetReply={setReply}
                      /*
                        The REAL on-chain author, never the display name. On a Lumen URL
                        `postData.author` has already been rewritten to the lite identity,
                        which is not a Hive account — a reply addressed to it names a
                        parent that does not exist on chain, so the broadcast fails after
                        four backoffs while the composer reports success and the reply is
                        simply lost.
                      */
                      username={litePost?.chainAuthor || postData.author}
                      permlink={permlink}
                      storageId={replyStorageId}
                      comment={storedComment}
                      discussionAuthor={author}
                      discussionPermlink={permlink}
                      observer={observer}
                    />
                  </div>
                ) : null}
                {crossedPost ? (
                  <div className="mb-12 flex w-full justify-center">
                    <Link
                      href={`/@${postData.json_metadata.original_author}/${postData.json_metadata.original_permlink}`}
                    >
                      <Button variant="redHover">{`Browse to the original post by @${postData.json_metadata.original_author}`}</Button>
                    </Link>
                  </div>
                ) : null}
                <div className="md:hidden">
                  {!!suggestionData ? (
                    <div className="mt-6 border-t border-border pt-4">
                      <h2 className="mb-3 px-4 font-sanspro text-lg font-bold">
                        You Might Also Like
                      </h2>
                      <SuggestionsList suggestions={suggestionData} horizontal />
                    </div>
                  ) : null}
                </div>
              </div>
            ) : (
              <Loading loading={postIsLoading} />
            )}
          </div>
          <div id="comments" className="flex" />
          {/* ★ A gated NSFW post must not leak through its own comment thread
              (2026-08-09). Measured before this: the body was correctly withheld
              while the replies still fetched 3 images, because comment bodies
              render through their own component with no NSFW awareness at all.
              Hiding the thread until the reader reveals the post is the coherent
              rule — "this post is marked NSFW" should mean the whole post. */}
          {!!postData && paginatedDiscussionState && !nsfwHidden ? (
            <CommentsSection
              postData={postData}
              paginatedDiscussionState={paginatedDiscussionState}
              userCanModerate={!!userCanModerate}
              mutedList={mutedList || initialMutedList || []}
              mutedListUnknown={mutedListUnknown}
              flagText={communityData?.flag_text}
              discussionAuthor={author}
              discussionPermlink={permlink}
              observer={observer}
              commentsPage={commentsPage}
              setCommentsPage={handleSetCommentsPage}
            />
          ) : null}
      </PageShell>
      <PostingLoader isSubmitting={isSubmitting} />
    </>
  );
};
export default PostContent;
