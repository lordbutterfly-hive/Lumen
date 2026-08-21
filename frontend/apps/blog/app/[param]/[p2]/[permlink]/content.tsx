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
import PostedViaLumen from '@/blog/features/post-rendering/posted-via-lumen';
import { PostDeleteDialog } from '@/blog/features/post-rendering/post-delete-dialog';
import { SharePost } from '@/blog/features/post-rendering/share-post-dialog';
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
import {
  fetchCommunity,
  fetchCommunityRoleOfAccount,
  fetchListVotesByCommentVoter,
  fetchPost,
  fetchPostStatus
} from '@/blog/lib/chain-fetch';
import { fetchDiscussion } from '@/blog/lib/lite/client/discussion-fetch';
import { isBlockedEntry, useLumenBlock, useLumenBlockList } from '@/blog/lib/lite/client/use-lumen-block';
import { litePostIdOf, isLumenProxiedEntry } from '@/blog/lib/lite/render/lite-post-id';
import { fetchLiteEntryByPermlink } from '@/blog/lib/lite/client/lite-post-fetch';
import { fetchLiteEngagement } from '@/blog/lib/lite/client/lite-engagement';
import { Entry } from '@hive/common-hiveio-packages/wax';
import { fetchActiveVotes } from '@/blog/lib/chain-fetch';
import { getSimilarPostsByPost, getHiveSenseStatus, isPostStub } from '@transaction/lib/hivesense-api';
import { Button } from '@ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@ui/components/dropdown-menu';
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
import { Link } from '@hive/ui';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CircleSpinner } from 'react-spinners-kit';
import { useStorageWithTTL } from '@ui/hooks/useStorageWithTTL';
import { StorageTTL } from '@ui/lib/storage-with-ttl';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import VotesComponentWrapper from '@/blog/features/votes/votes-component-wrapper';
import VotesComponent from '@/blog/features/votes/votes-component';
import { voteStyles } from '@/blog/features/votes/blade';
import { cn, isCommunity } from '@ui/lib/utils';
import { isNotePost } from '@/blog/lib/short-post-note';
import {
  useSSRObserver,
  useInitialPostData,
  useInitialDiscussion,
  useInitialCommunity,
  useInitialFollowList
} from '@/blog/components/observer-provider';
import { StaleTime } from '@/blog/lib/react-query';
import { authorTitleOf } from '@/blog/lib/author-title';

// Maximum number of comments per page
const MAX_COMMENTS_PER_PAGE = 50;

/** How many thread nodes one `/api/lite/posts/replies` call may ask about. Must
 *  match `MAX_PARENTS` in that route — asking about more is not an error there,
 *  it is silently ignored, so the cap is enforced here and REPORTED (see
 *  `parentsTruncated`) rather than applied blind. */
const MAX_LITE_REPLY_PARENTS = 200;

const logger = getLogger('app');

/**
 * ★ SECOND, INDEPENDENT COPY of the entity-decode this page's own `<h1>` and
 * share buttons need (2026-08-13, audit O6 item 2). `postData.title` is the
 * chain's raw bytes — some Hive clients write titles with un-decoded HTML
 * entities (confirmed live: `don&#039;t stop journey`, byte for byte on
 * chain) — and nothing on this page decoded them before putting the string
 * in the `<h1 data-testid="article-title">` or handing it to
 * Twitter/LinkedIn/Reddit/native share as the shared text. Same
 * self-contained approach as `layout.tsx`'s `og:description` fix: not
 * imported from `lib/utils.ts`, which is a different agent's file and whose
 * `getPostSummary`/`htmlDecode` never ran on this path anyway.
 */
const TITLE_NAMED_ENTITY_DECODE_TABLE: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  acute: '´',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”'
};

function decodeTitleEntities(text: string): string {
  return text.replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity[0] === '#') {
      const codePoint =
        entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      // ★ RANGE-GUARDED (2026-08-13) — THE THIRD COPY OF THIS BUG.
      // `Number.isFinite` alone lets an out-of-range code point through, and
      // `String.fromCodePoint` THROWS on it: `&#1114112;`, `&#x110000;` and
      // `&#99999999999999999999;` all do, and any Hive account can put those bytes
      // in a title. This copy runs inside a `useMemo` DURING RENDER, so unlike the
      // metadata twin — where the throw was swallowed and only cost the share
      // preview — here it takes the whole post page down.
      // `lib/utils.ts` had the guard from the start; `layout.tsx` was patched; this
      // one was missed twice. Same bug, three files.
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }
    return TITLE_NAMED_ENTITY_DECODE_TABLE[entity] ?? match;
  });
}

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
    // ★ NOT `Date.now()` (2026-08-13, audit O2 item 2a). `initialPostData` is
    // `getPostCached` (page.tsx) — a raw chain read that has never seen the
    // Lumen-vote merge above (:209-219), which is the ONLY code on this page
    // that applies it. Stamping the SSR data as fresh-now made React Query
    // treat it as valid for the full `staleTime` (2 minutes) and skip the
    // `queryFn` on mount, so the merge never ran on an ordinary page view — a
    // reader's own Lumen vote reverted to the chain-only count on every
    // reload. `0` marks the SSR data stale so the merge runs one round trip
    // later; `staleTime` still governs every fetch AFTER that first one.
    //
    // ★ CORRECTION (2026-08-21). This note used to end "`0` still paints the
    // SSR data instantly (no spinner, no layout shift)". The DATA is indeed
    // still painted — but the claim about the spinner was wrong, and it cost
    // this page its server-rendered article for eight days. React Query v4
    // reports `isLoading === true` for the whole lifetime of a query carrying
    // `initialDataUpdatedAt: 0`, data present or not (measured with
    // `renderToString` against this repo's own v4). Anything gating on
    // `postIsLoading` therefore rendered its loading arm on EVERY server
    // render. One did: the article body's slot. Keep `0` — it is correct for
    // the reason above — but never gate rendered output on `postIsLoading`
    // while it is set; gate on whether `postData` exists.
    initialDataUpdatedAt: 0,
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
  // Decoded once, used everywhere the title is actually shown to a person —
  // the <h1> and every share button below. Never applied to postData.title
  // itself: other code on this page (the reshare check, e.g.) reads the raw
  // chain value on purpose.
  const displayTitle = useMemo(
    () => (postData?.title ? decodeTitleEntities(postData.title) : ''),
    [postData?.title]
  );
  /** See the `<h1>` below — a short-form note carries no headline of its own. */
  const isNote = isNotePost(postData?.json_metadata);
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
    // ★ DO NOT RETRY: THE FAILURE THIS QUERY ACTUALLY SEES IS PERMANENT (2026-08-14).
    //
    // `getSimilarPostsByPost` funnels every failure through
    // `logStandarizedError`, which ENDS IN `throw` — so a rejection here always
    // reached React Query's default `retry: 3`. The rejection a short post
    // produces is a 400 reading "has no stored embedding (too short or not yet
    // processed)", and no amount of retrying inside one render changes whether
    // an embedding exists. The cost was three wasted round trips plus three
    // writes to the per-IP daily rate limiter in `app/api/hivesense/route.ts`
    // on every short post.
    //
    // `false` rather than a smaller number because the status of the error is
    // lost by the time it gets here (`logStandarizedError` rethrows a bare
    // `Error`), so a transient blip cannot be told apart from the permanent
    // case — and "You might also like" is a suggestion strip: the honest
    // response to a failed fetch is to show nothing and try again on the next
    // navigation, not to spend the reader's rate-limit budget guessing.
    retry: false,
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
    // ★ SEED IT STALE (2026-08-13) — WITHOUT THIS, TODAY'S COMMENT-VOTE FIX DOES
    // NOTHING. `/api/discussion` gained `mergeLumenEngagement` today so a lite
    // reader's vote on a COMMENT stops vanishing on reload. But this seed comes from
    // `page.tsx`'s raw `getDiscussion` with no merge, and `Date.now()` told React
    // Query it was freshly fetched — so for the whole `staleTime` window the
    // merge-including `queryFn` never ran, and an ordinary page load is exactly that
    // window. The fix was live in the route and inert on the path every reader takes.
    //
    // This is the inverse of the change made to `postData` 188 lines above, in this
    // same file, for this same reason. Same bug, same file, missed twin.
    initialDataUpdatedAt: initialDiscussion ? 0 : undefined,
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
  // ★ SEND THE PARENT SET, NOT JUST THE ROOT (2026-08-13, audit O1 item 3).
  //
  // The route below matched replies whose `publish_parent_*` equals exactly
  // ONE pair — the root post's `author`/`permlink`. A NESTED reply's parent
  // is the comment it replied to, not the root post, so that row was never
  // returned and never merged; the tree (which places children by
  // `parent_author`/`parent_permlink`, see `paginatedDiscussionState` and
  // `comment-list.tsx`) had nothing to hang it on. `discussionData` is
  // `Record<'author/permlink', Entry>` — the whole chain thread, keyed by
  // identity — so its own keys ARE the exact set of parents a reply on this
  // page can have. The root key is included as element 0 unconditionally:
  // `discussionData` may not have resolved yet on the first render.
  // ★ SHAPE RECONCILED WITH THE ROUTE (2026-08-13). The client and the route were
  // built in parallel and shipped two different contracts: this sent repeated
  // `parent=<author>/<permlink>` params, while `/api/lite/posts/replies` reads a
  // single `parents` param holding a JSON array of `[author, permlink, depth]`
  // triples. Either half alone is inert — the route would have ignored the repeated
  // params and silently kept its root-only behaviour, so nested replies would still
  // never have appeared and both halves would have looked correct in review. This is
  // the route's shape.
  //
  // `depth` is each node's own depth in the thread (root = 0, Hive convention). The
  // route stamps every returned reply with the parent it ACTUALLY matched rather
  // than the thread root, which is the whole point: `comment-list.tsx` places a
  // reply by `parent_author`/`parent_permlink` equality, so a row attributed to the
  // root can never attach under a comment.
  // ★ THE PARENT CAP REPORTS ITSELF (2026-08-13, adversarial review S3). This was
  // a bare `triples.slice(0, 200)` with the comment "the route's own cap" and no
  // signal — the first of three stacked silent truncations on this path. A thread
  // with more than 199 chain comments simply never asked about the nodes past the
  // cut, so their lite replies were not hidden, they were never requested, and the
  // page said nothing. `parentsTruncated` rides along so the reader is told.
  const { parentKeys, parentsTruncated } = useMemo(() => {
    const triples: [string, string, number][] = [[author, permlink, 0]];
    for (const entry of Object.values(discussionData ?? {})) {
      if (entry?.author && entry?.permlink) triples.push([entry.author, entry.permlink, entry.depth ?? 1]);
    }
    return {
      parentKeys: triples.slice(0, MAX_LITE_REPLY_PARENTS), // the route's own cap
      parentsTruncated: triples.length > MAX_LITE_REPLY_PARENTS
    };
  }, [author, permlink, discussionData]);
  const { data: liteReplyResult } = useQuery({
    // `parentKeys.length`, not the object itself: once `discussionData`
    // lands the parent set grows and this must refetch to pick up replies
    // nested under comments that were not known about yet.
    queryKey: ['liteReplies', author, permlink, parentKeys.length],
    queryFn: async (): Promise<{ entries: Entry[]; truncated: boolean }> => {
      // `author`/`permlink` stay as top-level params — they are the THREAD's
      // identity, which the route still needs for owner-block resolution
      // (effect B applies thread-wide). Omitting `parents` entirely is defined
      // by the route as an additive, non-breaking version of the old root-only
      // behaviour, so this call degrades rather than breaking if the two ever
      // drift again.
      const qs = new URLSearchParams({ author, permlink, parents: JSON.stringify(parentKeys) });
      const res = await fetch(`/api/lite/posts/replies?${qs.toString()}`);
      if (!res.ok) return { entries: [], truncated: false };
      const body = (await res.json()) as { entries?: Entry[]; truncated?: boolean };
      return { entries: body.entries ?? [], truncated: !!body.truncated };
    },
    staleTime: StaleTime.MEDIUM,
    // A thread must not break because this optional merge failed.
    onError: () => undefined
  });
  const liteReplies = liteReplyResult?.entries;
  // Either half of the path can clip: this page's own parent list, or the route's
  // per-parent / per-batch caps. Both mean the same thing to a reader — some
  // replies exist that are not on this screen — so they surface as one line.
  const liteRepliesTruncated = parentsTruncated || !!liteReplyResult?.truncated;

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
    // and payout).
    //
    // ★ THE AUTHOR IS NOT STABLE ACROSS THE MOVE — THIS KEY WAS NEVER MATCHING
    // (2026-08-13). The comment here used to claim `author/permlink` was "stable
    // across the move". It is not: a lite reply is authored by the reader's own
    // Lumen handle before it publishes and by the frontend's Hive account after,
    // so the two copies never shared a key and the de-duplication never fired
    // once. Measured on a real mainnet thread, 3/3:
    //
    //   /api/lite/posts/replies -> newcomerql62c/lumen-01kzhcb8…
    //   /api/discussion         -> hbd-temp/lumen-01kzhcb8…
    //
    // Every published lite reply therefore rendered TWICE, and the duplicate was
    // the pre-publish copy that carries the "Publishing…" badge — so a reply that
    // had long since landed still showed as in-flight beside itself.
    //
    // `litePostIdOf` recovers the Lumen row id from either permlink form
    // (`lumen-<ULID>` published, `lite-<ULID>` not), which is what genuinely
    // survives the move. Both keys are kept: the id catches the same row under two
    // authors, and `author/permlink` still catches anything that arrived by a route
    // with no Lumen id to recover.
    if (liteReplies && liteReplies.length > 0) {
      const seen = new Set(list.map((c) => `${c.author}/${c.permlink}`));
      for (const chainCopy of list) {
        const id = litePostIdOf(chainCopy);
        if (id) seen.add(`id:${id}`);
      }
      for (const reply of liteReplies) {
        if (isBlockedEntry(reply, viewerBlocks)) continue;
        const replyId = litePostIdOf(reply);
        if (replyId && seen.has(`id:${replyId}`)) continue;
        if (!seen.has(`${reply.author}/${reply.permlink}`)) {
          // Depth from the reply's OWN parent, not from the query's args —
          // now that a reply can be nested under any parent in `parentKeys`
          // above, `author`/`permlink` (the root) no longer identify which
          // parent a given row actually belongs to; only the row's own
          // `parent_author`/`parent_permlink` do. `depth` only affects
          // indentation and the depth-8 cap, never parent selection, so
          // getting it wrong here mis-indents rather than hides the reply.
          const parent = discussionData?.[`${reply.parent_author}/${reply.parent_permlink}`];
          list.push({ ...reply, depth: (parent?.depth ?? 0) + 1 });
        }
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


    /*
     * ★★ WHICH PAGE IS A GIVEN COMMENT ON. Added 2026-08-20 for the
     * card-expansion spec §9 ("Jump to comment"), which names this exact
     * problem as a blocker: "On a thread with 183 comments, confirm whether the
     * target comment is in the DOM at click time or whether the list is
     * paginated. If it is, resolve and render the correct page BEFORE the jump,
     * or the anchor does not exist and the jump silently fails."
     *
     * It IS paginated — that is what `pages` above is — so a bare `#@a/b` hash
     * lands on nothing for any comment past page 1. This map is the resolution
     * step: `comments-section.tsx` reads it on arrival and moves to the right
     * page before scrolling.
     *
     * Built FROM `pages` rather than recomputed, so it cannot disagree with the
     * pagination it describes. First page wins if a key somehow appears twice,
     * which matches the render.
     */
    const pageOfKey = new Map<string, number>();
    pages.forEach((set, i) => {
      for (const k of set) if (!pageOfKey.has(k)) pageOfKey.set(k, i + 1);
    });

    return {
      comments: paginatedComments,
      totalPages,
      currentPage: validPage,
      totalMainComments: mainComments.length,
      pageOfKey
    };
  }, [discussionState, postData, commentsPage]);

  /*
   * ★★ THE COUNT THE READER CAN ACTUALLY SEE (2026-08-20, owner report: "the
   * comments are hidden but under the card it says 2").
   *
   * `postData.children` is Hivemind's raw recursive count and is wrong in BOTH
   * directions on this page:
   *   TOO HIGH — it counts comments the post owner blocked (filtered server-side
   *     in `/api/discussion`) and comments THIS reader blocked (filtered just
   *     above, in `discussionState`).
   *   TOO LOW  — it cannot count a lite reply that has been accepted but not yet
   *     broadcast to chain, which `discussionState` merges in for every reader.
   * So the header could claim 2 over an empty thread, or 0 over a visible reply.
   *
   * `discussionState` is the list this page actually renders, after both block
   * mechanisms and after the lite merge, so its length IS the answer — minus the
   * root post, which `bridge.get_discussion` always includes and which is not a
   * comment. It costs nothing: the thread is already in hand.
   *
   * ★ THE DELETE GATE DELIBERATELY DOES NOT USE THIS. A few lines below,
   * `postData.children === 0` still decides whether the hard-Delete control is
   * offered, and it must keep reading the CHAIN's count: `canDelete` in
   * `hive-broadcaster.ts` re-checks the same thing against a live node, and a
   * blocked reply still exists on chain. Showing Delete because a reply is hidden
   * would offer an action the chain will refuse.
   */
  const visibleCommentCount =
    discussionState && discussionState.length > 0
      ? discussionState.filter((c) => c.depth !== (postData?.depth ?? 0)).length
      : (postData?.children ?? 0);
  const firstPost = discussionState?.find((post) => post.depth === 0);
  const post_is_pinned = firstPost?.stats?.is_pinned ?? false;

  const thisPost = discussionState?.find((post) => post.permlink === permlink && postData?.author === author);
  // Use thisPost.depth if available, fallback to postData.depth (for optimistic posts), default to 0
  const postDepth = thisPost?.depth ?? postData?.depth ?? 0;
  /**
   * ★★★ A LUMEN POST IS NOT "A COMMENT SOMEBODY LINKED TO" (2026-08-16, QA
   * defect B1).
   *
   * `commentSite` used to be bare `postDepth !== 0` — condenser-era logic for
   * "the URL points at a reply, so show the single-comment-thread banner
   * instead of a normal post". True for an ordinary Hive reply; wrong for a
   * Lumen "lite" post, which is ALWAYS broadcast as a depth-1 comment under a
   * rolling container root owned by the gateway account (`hbd-temp`,
   * permlink `lumen-c-<ulid>` — see `lib/lite/publisher/container.ts`) purely
   * because Hive caps root posts at one per 5 minutes per account. To a Lumen
   * reader this IS the post, not a reply buried in someone else's thread, so
   * it was rendering the "You are viewing a single comment's thread from...
   * itself" banner (root_title/title mixed up, see `ContextLinks`) with a
   * "View the full context" link straight to `/lumen/@hbd-temp/lumen-c-...`
   * — leaking the shared gateway account and container to every Lumen
   * reader, with no `<h1>` on the page at all (the banner's own `<h1>` was
   * the only one).
   *
   * `isLumenProxiedEntry` (shared with the lite badge/overlay logic —
   * `lib/lite/render/lite-post-id.ts`) covers the first two conditions from
   * the QA writeup: `json_metadata.app === "lumen/1.0"` and a
   * `lumen_post_id` marker, plus the `lumen-`/`lite-` permlink shape as a
   * third, stronger signal. The `parent_permlink` check below is the QA
   * writeup's third, independent condition — depth-1 directly under a
   * `lumen-c-` container — so a Lumen post is still recognised even if its
   * `json_metadata` were ever stripped or unparsed somewhere upstream. The
   * container namespace is exclusive to the gateway; no ordinary Hive
   * comment can carry it.
   */
  const isLumenNativePost =
    isLumenProxiedEntry(postData) ||
    (postDepth === 1 && (thisPost?.parent_permlink ?? postData?.parent_permlink ?? '').startsWith('lumen-c-'));
  // `postDepth !== 0` on its own, kept under its own name for the ONE place
  // below that must still ask it directly: which EDITOR to open. A Lumen post
  // genuinely IS a depth>0 Hive comment on chain (the whole reason it needs
  // `isLumenNativePost` above at all), and its edit has to go through
  // `ReplyTextbox`'s comment-update path — the one that knows how to proxy a
  // keyless lite session's edit — never `PostForm`, which has no lite
  // awareness at all (grepped: zero references to `chainAuthor`, lite or
  // account_tier in post-form.tsx). Routing `commentSite` there instead would
  // have swapped editors out from under a Lumen post the moment this fix
  // landed, breaking Edit for every Lumen author to fix a display bug.
  const isReplyOnChain = postDepth !== 0;
  const commentSite = isReplyOnChain && !isLumenNativePost;
  const userFromDMCA = dmcaUserList.some((e) => e === postData?.author);

  /**
   * ★ THROUGH OUR SERVER, NOT THE CHAIN CLIENT (2026-08-12). Unconditional
   * (no `initialData`) on every community post — the highest-traffic page in
   * the app. See `apps/blog/app/api/community-roles/route.ts`, which also
   * backs `roles/[tag]/content.tsx`'s own, separately-broken instance of this
   * same read (see that file for its own key-mismatch note).
   *
   * ★★★ IT ASKS FOR ONE ROW NOW, AND ONLY WHEN THE ANSWER CAN BE YES
   * (2026-08-13, browser audit §2.4). Measured signed in on a community post:
   * a flat 131-482ms, `private, no-store`, on every single load, to download
   * every role row in the community (**593** of them for `hive-141359`) and
   * reduce them here to the one boolean below. Three things were wrong with
   * that and all three are fixed:
   *
   * - The reduction is now done by the route (`?account=`), so the response is
   *   one small object instead of the whole table.
   * - It is `enabled` only when there is a Hive account that could hold a role.
   *   Signed out, `user.username` is `''`, `userRole` was always `undefined`
   *   and the answer was always `false` — so every signed-out reader of every
   *   community post paid that request for a foregone conclusion. A Lumen lite
   *   account is not a Hive account at all and cannot hold a Hive community
   *   role, the same gate `use-logged-user.tsx` and the follow-list query on
   *   this very page already apply. `identity.clientAnswered` is required
   *   because the tier is only known once the client has answered, and this
   *   gate CLOSES a capability — the documented posture for that case
   *   (`features/layouts/server-session.tsx`) is to keep it closed until then,
   *   rather than fire a request against a name that may not be on chain.
   * - The upstream read behind it is memoised server-side, so the loads that do
   *   still make this request no longer pay the chain round trip.
   *
   * Its own query key, not `['rolesList', …]`: that key holds the FULL list for
   * `/roles/[tag]` and its mutations (`use-set-role-mutations.ts` reads and
   * writes it as `string[][]`). Two different shapes must never share one entry.
   */
  const canHoldCommunityRole =
    identity.clientAnswered && !!user.username && user.account_tier !== 'lite';
  const { data: userCanModerate } = useQuery({
    queryKey: ['communityRoleOfViewer', category, user.username],
    queryFn: () => fetchCommunityRoleOfAccount(category, user.username),
    enabled: postInCommunity && canHoldCommunityRole,
    onError: (error) => {
      handleError(error, { method: 'getListCommunityRoles', params: { category } });
    },
    select: (data) => data.role === 'mod' || data.role === 'admin' || data.role === 'owner'
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
   * ★★★ THE POST-HEADER "···" OVERFLOW MENU (2026-08-16) — replaces the
   * standalone "Flag post" icon button that used to be alone in this slot.
   * Three items, one trigger: Downvote (economic action, first), Flag post
   * (moderation, second, only where flagging is even possible), a rule, then
   * Block (user-level, last) — the spec's own ordering rationale.
   *
   * ★ WHY A HIDDEN SECOND `VotesComponent` RATHER THAN A NEW DIALOG. The
   * brief is explicit: reuse the EXISTING downvote weight popover / removal
   * dialog, never build a second one. That control (the Popover slider, the
   * `VoteRemovalDialog` once already cast, the sub-threshold one-shot
   * button, the signed-out `DialogLogin` prompt) only exists in the tree
   * when `showDownvote` is true, and `showDownvote` is deliberately NOT
   * passed to the visible footer `VotesComponentWrapper` below (see its own
   * call site) — the inline arrow must stay gone from the footer. So a
   * second, hidden instance is mounted here with `showDownvote` on, purely
   * to host the real control this menu clicks through a ref. Every one of
   * its four branches renders a real `data-testid="downvote-button"`
   * element, so one click handler works regardless of which state is live,
   * with zero vote logic duplicated — `features/votes/**` is untouched.
   *
   * ★ NEVER NEST THE TRIGGER INSIDE THE DROPDOWN ITEM. Both the vote
   * popover/removal dialog and `AlertDialogFlag` below are Radix primitives
   * with their own portalled Content. A `DropdownMenuItem` whose default
   * select behaviour closes (and Radix unmounts) `DropdownMenuContent` would
   * unmount a nested trigger in the same commit its own click is trying to
   * open a dialog in — the mount race the brief warns about. Both proxies
   * are mounted as SIBLINGS of the `DropdownMenu` instead (inside the same
   * wrapper below, never inside `DropdownMenuContent`), so closing the menu
   * cannot touch them; `onSelect` only clicks a ref.
   *
   * Focus return (req. 6) is forced rather than left to effect-ordering
   * chance: `overflowTriggerRef.current?.focus()` runs synchronously in the
   * same handler, BEFORE the proxy `.click()`. A `.click()` on a
   * `className="hidden"` (`display:none`) node cannot itself take focus —
   * browsers refuse to focus a non-rendered element — so by the time the
   * opened dialog's own focus-scope captures "what to return to", it is
   * already this trigger, deterministically, regardless of whether Radix's
   * own close-then-restore effect on the dropdown has run yet. Not
   * runtime-verified.
   */
  const overflowTriggerRef = useRef<HTMLButtonElement>(null);
  const hiddenDownvoteControlRef = useRef<HTMLDivElement>(null);
  const hiddenFlagTriggerRef = useRef<HTMLButtonElement>(null);

  // Same author correction as the footer `VotesComponentWrapper` call just
  // below (litePost carries the account that actually signed the post), so
  // this hidden instance's vote query key and mutation target the identical
  // row rather than a divergent one.
  const votePost = postData ? { ...postData, author: litePost?.chainAuthor || postData.author } : null;
  const voteVoter = identity.username;
  const isLiteVoter = user.account_tier === 'lite';
  // Same fallback `votes-component.tsx` itself uses ahead of its own
  // authoritative query answering — sign of `rshares` on the chain row this
  // page already has in `postData.active_votes`, no extra fetch needed.
  const chainDownvoteRow = postData?.active_votes?.find((v) => v.voter === voteVoter);
  const chainSaysDownvoted = !!chainDownvoteRow && Number(chainDownvoteRow.rshares) < 0;
  // ★ SAME QUERY KEY AS `votes-component.tsx`'s OWN `userVotes` QUERY, ON
  // PURPOSE — this is cache-SHARING, not a second, divergent read of the
  // same fact. The footer instance (and the hidden one below, once a vote is
  // cast through it) already populate this exact key via
  // `useVoteMutation`'s optimistic write; this observer only reads it, so
  // the trigger's tint/label stay live off that same write with no request
  // of its own in the common case (`enabled` mirrors the same fallback gate
  // `votes-component.tsx` uses).
  const { data: viewerVoteData } = useQuery({
    queryKey: ['votes', votePost?.author ?? '', votePost?.permlink ?? '', voteVoter],
    queryFn: () =>
      isLiteVoter
        ? fetchLiteEngagement(votePost?.author ?? '', votePost?.permlink ?? '')
        : fetchListVotesByCommentVoter(votePost?.author ?? '', votePost?.permlink ?? '', voteVoter),
    enabled: !!votePost && (isLiteVoter ? !!voteVoter : !!chainDownvoteRow),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false
  });
  const viewerVote =
    viewerVoteData?.votes?.[0] && viewerVoteData.votes[0].voter === voteVoter
      ? viewerVoteData.votes[0]
      : undefined;
  const hasDownvoted = viewerVote ? viewerVote.vote_percent < 0 : chainSaysDownvoted;

  const openDownvoteControl = () => {
    overflowTriggerRef.current?.focus();
    hiddenDownvoteControlRef.current
      ?.querySelector<HTMLButtonElement>('[data-testid="downvote-button"]')
      ?.click();
  };
  const openFlagDialog = () => {
    overflowTriggerRef.current?.focus();
    hiddenFlagTriggerRef.current?.click();
  };

  // Same target/name-space split as the byline's own Block (`ButtonsContainer`,
  // rendered further below) and the identical control already on feed cards
  // and comments (`medium-post-card.tsx`, `comment-list-item.tsx`):
  // `postFollowTarget` already resolves to the REAL signer (never a shared
  // Lumen publishing account) and is already `null` for "not logged in" or
  // "this is me" — see its own definition above.
  const overflowBlock = useLumenBlock(
    postFollowTarget ?? '',
    litePost?.author ? 'lumen' : 'hive',
    !!postFollowTarget
  );
  const handleOverflowBlockClick = async () => {
    const failure = await overflowBlock.toggle();
    if (failure) {
      handleError(new Error(failure), {
        method: overflowBlock.isBlocking ? 'lumen-unblock' : 'lumen-block',
        params: { username: postFollowTarget ?? '' }
      });
    }
  };

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
          the problem; only the chrome around it was.

          ★ THE SUGGESTION LIST MOVED TO THE RIGHT COLUMN (2026-08-13, audit §6).
          It used to be `leftRailExtra` — stacked under the primary nav in the
          200px left aside, as a scroller inside a sticky panel inside a sticky
          aside. See `page-shell.tsx`'s `rightRailExtra` note for the measured
          root cause. Below `xl` there is no right column, so the full strip
          below the article (the `xl:hidden` block further down) is what a
          narrow reader gets — it is no longer `md:hidden`, because between
          `md` and `xl` the panel would otherwise be nowhere at all. */}
      <PageShell
        mainClassName="min-w-0 py-8 flex flex-col"
        rightRailExtra={suggestionData ? <AnimatedList suggestions={suggestionData} /> : null}
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
                      {/* ★ A NOTE HAS NO HEADLINE (2026-08-14, composer audit
                          finding 7 / §9.6). A short post's `title` is only a
                          markdown-stripped, 60-character COPY of its own first
                          line — Hive requires a title, the writer never wrote
                          one. Printing it as a 30px extrabold H1 and then
                          printing the identical sentence again as the article
                          body is how a one-line note came to be presented as a
                          magazine feature. When `json_metadata.type` is `note`
                          the headline is dropped and the body speaks for itself;
                          the payout-in-HBD marker keeps its place beside the
                          flag control, and every post without the marker renders
                          exactly as it did before. */}
                      <h1
                        className={cn(
                          // ★★★ THE ONE PLACE WEIGHT 800 ACTUALLY MATTERED (2026-08-19, spec §6).
                          //
                          // This was `text-3xl font-extrabold tracking-tight` — 30px at
                          // weight 800. Lora's wght axis stops at 700 and does NOT
                          // synthesise, so leaving it would have made the post title
                          // render at the SAME weight as the 700 text around it while
                          // still claiming to be heavier: the headline would have got
                          // quietly LIGHTER, which is the opposite of what the class asks
                          // for and is invisible in a diff.
                          //
                          // The spec's answer is to buy the missing authority on two axes
                          // that Lora does have: size 30 -> 36 (+20%) and tracking tightened
                          // to -0.02em to rebuild the density the weight was carrying.
                          // `text-hero` (36/44) and `tracking-hero` (-0.02em) are exactly
                          // those values, now named. NOT `-webkit-text-stroke` and not a
                          // synthetic bold — both fake a weight the file does not have and
                          // look it.
                          //
                          // ★ THE RESPONSIVE STEP IS KEPT. The spec states one value; this
                          // element has always had two, and 36px is a lot of headline on a
                          // 390px phone. Mobile takes 28/36 — a proportional bump on the
                          // old 24px mobile step — and `sm:` upward takes the spec's 36/44.
                          // `tracking-tight` (-0.025em, tuned for a sans) is gone at both
                          // widths: it is the value the wordmark had to abandon in August
                          // when it became Lora, for the same collision reason.
                          'text-[28px] font-bold leading-[36px] tracking-hero text-foreground sm:text-hero',
                          isNote && 'sr-only'
                        )}
                        data-testid="article-title"
                      >
                        {displayTitle}
                        {postData.percent_hbd === 0 && (
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span
                                  className="ml-2 inline-flex items-center align-middle"
                                  data-testid="powered-up-100-trigger"
                                >
                                  <Icons.hive className="h-5 w-5 text-ink-brand-8" />
                                </span>
                              </TooltipTrigger>
                              <TooltipContent data-testid="powered-up-100-tooltip">
                                {t('cards.post_card.powered_up_100')}
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        )}
                      </h1>
                      {/* ★★★ THE "···" OVERFLOW MENU (2026-08-16) — replaces the
                          standalone Flag button that used to be alone in this
                          slot. Rendered whenever the post itself is (not gated
                          on `postInCommunity` any more, unlike the button it
                          replaces): Downvote is offered on every post, on or
                          off a community, the same as the upvote arrow beside
                          it always was, and gating the whole trigger on
                          community membership would have made downvoting from
                          this page impossible everywhere else. Flag post keeps
                          its original `postInCommunity` gate below — reporting
                          to community moderators only ever applied there. See
                          the big comment above (before `isPending`) for why
                          two Radix triggers are proxied through hidden
                          siblings rather than nested inside the menu items. */}
                      <div
                        className={cn(
                          voteStyles.root,
                          'mt-1 shrink-0 cursor-pointer rounded-full border border-transparent p-1.5 text-muted-foreground transition-colors hover:border-border hover:bg-background-secondary hover:text-destructive'
                        )}
                      >
                        <DropdownMenu>
                          {/* ★ THE "MINE" DOWNVOTE TINT, NOT A NEW RED (req. 5 +
                              req. 3). `--lm-vote-slate` is the exact token
                              `vote-control.module.css` uses for `.down.mine` —
                              slate, not `--destructive` — because the design
                              records disagreement rather than celebrating it,
                              and because a red trigger here would read as the
                              SAME action as Flag post. Reusing the token (via
                              `voteStyles` on the wrapper) keeps this
                              byte-identical and dark-mode aware instead of a
                              second, drifting hardcoded colour. */}
                          <DropdownMenuTrigger asChild>
                            <button
                              ref={overflowTriggerRef}
                              type="button"
                              data-testid="post-header-overflow-trigger"
                              aria-label={
                                hasDownvoted
                                  ? t('profile.overflow_menu_label_downvoted')
                                  : t('profile.overflow_menu_label')
                              }
                              /* ★ min-h/min-w-[24px] FOR THE HIT TARGET (2026-08-19, WCAG
                                  2.2 AA 2.5.8). Icon-only, no padding, exactly 16x16.
                                  Measured live: the wrapper div around this button grows
                                  from 30x30 to 38x38 (it hugs the button plus its own
                                  padding), but the post title row it sits in is governed
                                  by the h1's own height (44px either way) — unchanged. */
                              className="flex min-h-[24px] min-w-[24px] items-center justify-center"
                              style={hasDownvoted ? { color: 'var(--lm-vote-slate)' } : undefined}
                            >
                              <Icons.moreHorizontal className="h-4 w-4" aria-hidden />
                            </button>
                          </DropdownMenuTrigger>
                          {/*
                            ★★★ THE DOWNVOTE SLIDER OPENED AND VANISHED ~20ms LATER
                            (owner-reported 2026-08-17: "shows then disappears, can't
                            click it or the slider").

                            Two Radix focus effects racing, both behaving as designed:
                            selecting "Downvote" proxies a click to the real (hidden)
                            downvote button, which is a PopoverTrigger — the Popover
                            opens and its FocusScope pulls focus into the slider. This
                            menu is closing at the same moment, and Radix's DEFAULT
                            `onCloseAutoFocus` restores focus to the "…" trigger. The
                            Popover's DismissableLayer sees focus land outside itself
                            and dismisses. Instrumented trace, reproduced on a build
                            predating any of today's changes:

                              t+0.0ms   focus enters the slider   (Popover opened)
                              t+7.4ms   trigger aria-expanded=true
                              t+26.2ms  focus restored to "…"     (menu's close-autofocus)
                              t+29.0ms  aria-expanded=false       (Popover dismissed)

                            Silent — no error, no React warning — which is why it reads
                            as "just broken". Preventing the menu's focus restoration is
                            the same thing Radix's own MenuSubContent does internally for
                            exactly this reason: a closing menu must not steal focus from
                            whatever the selection just opened. Applies to every item in
                            this menu, so it covers Flag post too, which proxies the same
                            way.
                          */}
                          <DropdownMenuContent
                            align="end"
                            className="w-56"
                            onCloseAutoFocus={(event) => event.preventDefault()}
                          >
                            {/* Downvote — economic action, first. */}
                            <DropdownMenuItem
                              data-testid="post-header-downvote-menu-item"
                              onSelect={openDownvoteControl}
                            >
                              {hasDownvoted
                                ? t('post_content.footer.remove_downvote')
                                : t('post_content.footer.downvote')}
                            </DropdownMenuItem>
                            {/* Flag post — moderation, second. Same gate the
                                standalone button always had: only where
                                flagging is possible at all (a community post),
                                and only once we know WHICH of the two states
                                (signed out vs. signed in with community data
                                loaded) applies, matching exactly what the old
                                button rendered non-null for. Destructive
                                styling reused from the design system (not
                                invented here) so it stays the one item that
                                visibly contacts moderation — Downvote above is
                                deliberately NOT styled this way, see req. 3. */}
                            {postInCommunity && (!identity.isLoggedIn || communityData) ? (
                              <DropdownMenuItem
                                data-testid="post-header-flag-menu-item"
                                className="text-destructive focus:text-destructive"
                                onSelect={openFlagDialog}
                              >
                                {t('post_content.flag.flag_post')}
                              </DropdownMenuItem>
                            ) : null}
                            {/* Block — user-level, last, separated. Same
                                control already offered on feed cards
                                (medium-post-card.tsx) and comments
                                (comment-list-item.tsx): a direct click, no
                                nested confirm dialog, for the identical
                                nesting-safety reason documented above. */}
                            {postFollowTarget && (overflowBlock.available || overflowBlock.unknown) ? (
                              <>
                                <DropdownMenuSeparator />
                                {overflowBlock.available ? (
                                  <DropdownMenuItem
                                    onClick={handleOverflowBlockClick}
                                    disabled={overflowBlock.busy}
                                    className="cursor-pointer text-destructive focus:text-destructive"
                                    data-testid="post-header-block-menu-item"
                                  >
                                    {overflowBlock.isBlocking
                                      ? t('user_profile.unblock_button')
                                      : t('user_profile.block_button')}
                                  </DropdownMenuItem>
                                ) : (
                                  <DropdownMenuItem
                                    disabled
                                    className="cursor-not-allowed"
                                    data-testid="post-header-block-menu-item-unknown"
                                    title={t('user_profile.block_status_unknown_hint')}
                                  >
                                    {t('user_profile.block_status_unknown')}
                                  </DropdownMenuItem>
                                )}
                              </>
                            ) : null}
                          </DropdownMenuContent>
                        </DropdownMenu>

                        {/* Hidden proxy for the EXISTING downvote weight
                            popover / removal dialog / one-shot control — see
                            the big comment above `isPending`. `showDownvote`
                            is passed ONLY to this instance, never to the
                            visible footer `VotesComponentWrapper` below. */}
                        {votePost ? (
                          <div ref={hiddenDownvoteControlRef} className="hidden" aria-hidden="true">
                            <VotesComponent post={votePost} type="post" size="sm" showDownvote />
                          </div>
                        ) : null}

                        {/* Hidden proxy for the EXISTING flag dialog
                            (AlertDialogFlag) / login prompt — the identical
                            component and the identical branch the standalone
                            button used to render, just not visible. */}
                        {postInCommunity ? (
                          <div className="hidden" aria-hidden="true">
                            {!identity.isLoggedIn ? (
                              <DialogLogin>
                                <FlagIcon ref={hiddenFlagTriggerRef} onClick={() => {}} />
                              </DialogLogin>
                            ) : communityData ? (
                              <AlertDialogFlag
                                community={category}
                                username={author}
                                permlink={permlink}
                                flagText={communityData.flag_text}
                              >
                                <FlagIcon ref={hiddenFlagTriggerRef} onClick={() => {}} />
                              </AlertDialogFlag>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
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
                  {/*
                   * ★ items-CENTER, NOT items-start (2026-08-16, owner: "follow and
                   * block are weirdly positioned").
                   *
                   * Measured on /blog/@tonyz/bretagne-monomad-challenge signed in:
                   * the Follow/Block/Reblog cluster sat at y=202 with height 36
                   * (centre 220) while the byline text sat at y=223 with height 22
                   * (centre 234). The actions floated 14px ABOVE the line they
                   * belong to, which is what reads as "weird" rather than the
                   * spacing, which is a uniform 40px between all three.
                   *
                   * `items-start` only matters once this row WRAPS, and on wrap each
                   * line is full width anyway, so centring costs nothing there and
                   * fixes the common single-line case.
                   */}
                  <div className="flex flex-wrap items-center justify-between gap-2">
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
                      author_title={authorTitleOf(postData)}
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
                    {/* ★ FOLLOW AND REBLOG ARE ONE GROUP (2026-08-19, owner: "move
                        follow to the right next to reblog"). Removing the Block pill
                        left three children in a `justify-between` row — UserInfo,
                        Follow, Reblog — so the free space was shared out BETWEEN them
                        and Follow landed 69px clear of Reblog rather than beside it.
                        Wrapping the two actions in their own flex group makes the row
                        two children again: identity left, actions right, `gap-2`
                        between the pills. Measured 69px -> 8px. */}
                    <div className="flex items-center gap-2">
                      {postFollowTarget ? (
                        // ★ BLOCK PILL REMOVED FROM THIS ROW (owner ruling 2026-08-19:
                        // "Block does not belong in the post header — it's already in
                        // the '···' overflow menu"). Verified live in the browser
                        // before removing it: opening `post-header-overflow-trigger`
                        // shows a working `post-header-block-menu-item`
                        // (Block -> POST /api/lite/block -> Unblock, round-tripped
                        // against this server) — see `buttons-container.tsx`'s
                        // `hideBlock` doc comment. Follow now sits directly beside
                        // Reblog as a result, and `followButtonClassName` matches its
                        // resting-state border/background/weight to the Reblog pill's
                        // (`border-border bg-background`, no `outlineRed` slate
                        // border/transparent background, and `font-normal` instead of
                        // the shared `font-medium` base) — see FollowButton's own doc
                        // comment for the token-vs-token comparison.
                        <ButtonsContainer
                          username={postFollowTarget}
                          user={user}
                          variant="outlineRed"
                          liteTarget={Boolean(litePost?.author)}
                          hideMute
                          hideBlock
                          followButtonClassName="border-border bg-background font-normal"
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
                </div>
                {/*
                 * ★★★ NO `postIsLoading` GATE HERE — IT HID THE ARTICLE FROM EVERY
                 * SERVER RENDER (2026-08-21).
                 *
                 * This slot used to read `postIsLoading ? <Loading/> : ...`. Two facts
                 * combine to make that gate permanently true on the server:
                 *
                 *  1. Everything from `{postData ? (` (:1326) down to its `) : (`
                 *     (:2230) ALREADY runs only when `postData` exists, so a
                 *     "still loading" arm inside it can never be the honest case.
                 *  2. React Query v4 reports `isLoading === true` whenever
                 *     `initialDataUpdatedAt: 0` is set (:314) — even though `data` is
                 *     present. Measured directly against this repo's own v4 with
                 *     `renderToString`: `initialDataUpdatedAt: 0` -> isLoading=true,
                 *     hasData=true; the same query with the field omitted ->
                 *     isLoading=false. `0` is deliberate and must stay (see :304), so
                 *     the gate was true on EVERY server render of EVERY post.
                 *
                 * The result was that the SSR HTML carried the title, the byline, the
                 * tags and all 40 comment bodies — and a spinner where the article
                 * should be. Confirmed by curl on four different posts: the document
                 * held exactly one `#articleBody` fewer than the browser did, and the
                 * missing one was always the post's own. That is the precise defect
                 * `page.tsx`'s "WHY THIS ROUTE HAS NO loading.tsx" note says it
                 * removed the route-level `loading.tsx` to prevent: an article that is
                 * invisible without JavaScript, and a loader-to-article swap that IS
                 * this page's layout shift.
                 *
                 * It also broke `postContentOrder.spec.ts` (7 tests, imported from
                 * denser 2026-07-23, never modified since). `#articleBody` is NOT a
                 * unique id — every comment carries one — so `.first()` resolved to
                 * the first COMMENT while the post body was still absent, and every
                 * "this text should exist in the body" assertion read a stranger's
                 * reply instead.
                 */}
                {edit && isReplyOnChain && postData.parent_author && postData.parent_permlink ? (
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
                {/* ★ "posted via lumen" — the attribution line, under the post body and above
                    the tags. OUTSIDE the branch above on purpose: that ternary also renders the
                    muted, legal-block and copyright stand-ins, and an attribution under a post
                    nobody can read would be attributing something invisible. Renders nothing
                    for an entry Lumen did not publish — see the component. */}
                <PostedViaLumen entry={postData} className="mt-6" />
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
                    {/* ★ text-ink-10, not text-muted-foreground (2026-08-16, QA
                        defect H2). `text-muted-foreground` resolves to
                        `hsl(215.4 16.3% 46.9%)` — measured rgb(100,116,139),
                        byte-identical to raw Tailwind slate-500 — the same
                        off-palette grey the author-title badge further down in
                        this same row already moved off of. `ink-10` is the
                        token that replaced it everywhere else in this file
                        (see that badge's own comment, and the
                        `liteRepliesTruncated` notice below). */}
                    <div className="flex flex-wrap items-center gap-1.5 text-sm text-ink-10">
                      <Icons.clock className="mr-1 h-4 w-4" />
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
                        {/* text-ink-10, not text-ink-info-6: slate is off-palette (the
                            followers redesign removed the last of it) and this badge is
                            one of the few places it survived. */}
                        {/*
                          ★ author_title BADGE REMOVED (2026-08-16, spec). It printed free text any
                          community's moderators can set via `set_label`, in a slot that looked
                          authoritative. Lumen shows a reputation score for Hive accounts and a quill
                          mark for lite accounts, and wants no third identity signal.
                          ChangeTitleDialog STAYS: it is the moderator's write control for that label,
                          a real on-chain feature still visible on other front ends. It rendered
                          unconditionally before (the falsy branch existed so a first title could be
                          set), so un-nesting it from the badge changes no reachability.
                        */}
                        <ChangeTitleDialog
                          community={category}
                          moderateEnabled={!!userCanModerate}
                          userOnList={postData.author}
                          title={authorTitleOf(postData)}
                          permlink={permlink}
                        />
                      </div>
                    </div>
                    {/* Stats */}
                    {/* ★ NO MORE INNER CARD (2026-08-16, QA defect H2). This used to
                        be its own `rounded-md border border-border bg-background
                        px-2.5 py-1.5` box sitting next to the plain-text meta info —
                        measured as three different type sizes in one row (14px meta,
                        18px vote tally, 20px payout) with three unaligned baselines,
                        so it read as two unrelated components bolted together rather
                        than one footer. The box is gone; `items-baseline` (not
                        `items-center`) is what actually lines text baselines up,
                        which centring the whole box never did. */}
                    {/* ★ items-center, NOT items-baseline (owner, 2026-08-18: "upvotes on
                        post are still not in line with dollar amount and vote numbers").
                        `items-baseline` aligns every child on its own TEXT baseline. That
                        is right for three runs of text and wrong the moment one child is a
                        38px control: the vote component's baseline is its tally's, so the
                        blade glyph above that tally was pushed up out of the row while the
                        digits themselves looked correct. The dividers already carried
                        `self-center` to escape this - a per-child override is the tell
                        that the container rule was fighting its own contents. All three
                        groups are the same 14px type, so centring them lines the text up
                        exactly as baseline did, and lines the glyph up too. */}
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      {/* The REAL signer: a full Hive user's vote is a chain op, and
                          our own vote table keys on the same value the read path sends.
                          A display name is neither stable (it changes at upgrade) nor a
                          Hive account. `author` here is a key, never display text. */}
                      {/* ★ THE POST PAGE IS THE FULL-SIZE VARIANT (2026-08-14,
                          Blade handoff): 28px glyph, 53x53 target, 18px tally.
                          Everywhere else — feed cards, comments — takes the
                          component's `sm` default. This is the ONLY call site
                          that needs the prop.
                          ★ SUPERSEDED for this one call site by the note directly
                          below: the owner ruled on H2 and the footer takes `sm`. The
                          handoff still governs the control everywhere it is full
                          size. */}
                      {/*
                       * ★ ONE TYPE SIZE IN THE FOOTER ROW (2026-08-16, owner, QA H2).
                       *
                       * `size="default"` renders a 53x53 target with an 18px tally,
                       * beside a 14px meta line and a 14px payout: three sizes in one
                       * row, and a bordered block roughly 3x the height of the text it
                       * sits next to, which is why the row read as two unrelated
                       * components bolted together. `sm` is 38x38 with a 14.5px tally,
                       * so the whole row lands on one size.
                       *
                       * This deliberately overrides the earlier "the post page passes
                       * size=default" handoff note on VotesComponent: that decision
                       * predates the footer being measured as a row, and the owner has
                       * called it directly. The prop still exists and nothing else
                       * changes, so restoring it is one word.
                       */}
                      <VotesComponentWrapper
                        post={{ ...postData, author: litePost?.chainAuthor || postData.author }}
                        type="post"
                        size="sm"
                      />
                      <span className="h-4 w-px self-center bg-border" />
                      <DetailsCardHover
                        post={postData}
                        decline={parseFloat(postData.max_accepted_payout) === 0}
                        post_page
                      >
                        <span
                          data-testid="comment-payout"
                          // ★ text-sm, not text-[20px] (2026-08-16, QA defect H2,
                          // supersedes the 2026-08-14 note below). Bumping the payout to
                          // 20px "one step above the tally" fixed one mismatch (payout
                          // vs. tally) by introducing a THIRD size into a row that
                          // already had two — this is the "three type sizes in one row"
                          // finding. `text-sm` matches the meta info line, `font-bold`
                          // keeps the money figure the visually heaviest thing in the
                          // row without giving it its own size step.
                          //
                          // ★ text-ink-brand-8, not text-destructive (same defect): the
                          // measured colour was raw Tailwind red-500 (rgb(239,68,68)),
                          // and `ink-brand-8` is the token that is byte-identical to it
                          // (globals.css) — already used for this exact figure's
                          // DECLINED state two lines below (`!text-ink-8`) and for the
                          // `post_page` decline branch in `details-card-hover.tsx`, so
                          // this is the same family, not a new one.
                          // ★★ GREEN, NOT RED (2026-08-20, owner-reported: "the payout there is red
                          // instead of green ... that shows unprofessional as on feed payout is green").
                          // The note above is right about its own question and never asked the bigger
                          // one: it found raw Tailwind red-500 here and swapped in the token that is
                          // byte-identical to it, which tokenised the red and left the money red.
                          // Measured: this figure #ef4444, the feed card #2a6b44 — same number, two
                          // opposite colours. `--ink-payout` is the feed card's own green, promoted to a
                          // global token so these two cannot drift again.
                          className={`text-sm font-bold text-[color:rgb(var(--ink-payout))] hover:cursor-pointer ${
                            parseFloat(postData.max_accepted_payout) === 0
                              ? '!text-ink-8 line-through'
                              : ''
                          }`}
                        >
                          ${postData.payout?.toFixed(2)}
                        </span>
                      </DetailsCardHover>
                      {/* ★★ THE SECOND VOTE COUNT IS GONE (owner, 2026-08-18: "we dont need
                          both upvote numbers there. remove the one on the right").
                          
                          This row showed TWO counts that disagreed: the blade's tally (296)
                          and `stats.total_votes` (297). Both were correct and they measure
                          different things - the tally is upvotes, `total_votes` is every
                          vote on the post including downvotes and zero-weight ones - but
                          nothing on the row said so, so it read as the same number rendered
                          twice and wrong once. One count, and it is the one attached to the
                          control that changes it.

                          ★ WHAT WENT WITH IT: this span was the trigger for
                          `DetailsCardVoters`, the click-through to the full voter list.
                          That affordance no longer exists anywhere on this row. It is a
                          real loss, not a tidy-up - if it should come back, the place for
                          it is the blade's own tally, not a second number. */}
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
                      {identity.isLoggedIn ? (
                        <>
                          <button
                            onClick={() => {
                              setReply(!reply);
                            }}
                            /* Was `text-destructive` - raw Tailwind red-500, which is
                               neither Lumen's brand red nor a colour used anywhere else
                               here. Now the same chip every other action on this row
                               wears. */
                            className="flex h-9 items-center rounded-control px-2.5 py-1.5 font-medium text-ink-action transition-colors hover:bg-[#f4f5f7] hover:text-brand"
                            data-testid="comment-reply"
                          >
                            {t('post_content.footer.reply')}
                          </button>
                          {pinMutations.isLoading || unpinMutation.isLoading ? (
                            <div className="ml-2">
                              <CircleSpinner
                                loading={pinMutations.isLoading || unpinMutation.isLoading}
                                size={18}
                                color="rgb(var(--brand))"
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
                                  color="rgb(var(--brand))"
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
                      <TooltipProvider>
                        <Tooltip>
                          {/* ★ min-h-[24px] FOR THE HIT TARGET (2026-08-19, WCAG 2.2 AA
                              2.5.8). This is the post page's OWN response-count control —
                              a separate, unfixed sibling of `post-card-comment-tooltip.tsx`
                              (the feed card's version, already fixed 2026-08-19). Measured
                              27.6x22; the icon (h-4 w-4) plus text-sm line-height gave 22px
                              with nothing setting a height. Measured live: the action row
                              (`comment-respons-header`) stayed 36px, governed by the
                              "Reply" chip's own h-9 — 0px cost. */}
                          {/* ★★ `asChild` + a LABEL (2026-08-21, found by a keyboard-only pass).
                          
                              Without `asChild`, Radix renders its own <button> AROUND this <Link> — so
                              the control was `<button><a/></button>`: interactive content nested inside
                              interactive content, which is invalid HTML and gives TWO tab stops for one
                              destination. Measured live: both the button and the link were reachable,
                              and NEITHER carried an aria-label, so a screen reader announced "8, button"
                              then "8, link" — a number with no noun attached.
                          
                              The note above already called this "a separate, unfixed sibling of
                              post-card-comment-tooltip.tsx". It is now fixed the same way: `asChild`
                              makes the Link itself the trigger (one stop, one element), and the label
                              reuses the same translated string the tooltip shows, so the count is
                              announced as "N responses" rather than as a bare digit. */}
                          <TooltipTrigger asChild data-testid="comment-respons">
                            <Link href={postData.url} aria-label={t('post_content.footer.responses', { responses: visibleCommentCount })}
                              className="flex min-h-[24px] cursor-pointer items-center text-muted-foreground transition-colors hover:text-foreground">
                              {/* ★ SAME SINGLE GLYPH AS THE FEED (owner, 2026-08-18). The
                                  post page carried the identical count-dependent swap that
                                  `post-card-comment-tooltip.tsx` did, so a reader clicking
                                  a card watched the comment mark change shape on arrival
                                  as well as between cards. The count beside it already
                                  says how many. */}
                              <Icons.comment className="mr-1 h-4 w-4" />
                              <span className="font-medium">{visibleCommentCount}</span>
                            </Link>
                          </TooltipTrigger>
                          <TooltipContent data-testid="post-footer-response-tooltip">
                            <p>
                              {visibleCommentCount === 0
                                ? t('post_content.footer.no_responses')
                                : visibleCommentCount === 1
                                  ? t('post_content.footer.response')
                                  : t('post_content.footer.responses', { responses: visibleCommentCount })}
                            </p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </div>
                    {/* ★★ ONE SHARE CONTROL, NOT A STRIP OF BRAND LOGOS (owner, 2026-08-18:
                        "the post card needs updating. its still on old hiveblog design").

                        This was a bordered pill holding four social-network logos plus a
                        link icon - the single most dated element on the page, and the one
                        thing on this row that looked borrowed from another product. The
                        four networks were not deleted: they moved INTO the share dialog,
                        which previously offered only copy-link and copy-markdown. Every
                        destination a reader could reach before, they can still reach.

                        The chip matches the feed card's action chips exactly - same 36px
                        box, same `rounded-control`, same `text-ink-action` at rest and
                        brand on hover - so the post page and the feed now speak one
                        language instead of two. */}
                    <SharePost path={postData.url} title={displayTitle}>
                      <span
                        className="flex h-9 items-center gap-1.5 rounded-control px-2.5 py-1.5 font-medium text-ink-action transition-colors hover:bg-[#f4f5f7] hover:text-brand"
                        data-testid="share-post"
                      >
                        <Icons.link className="h-[18px] w-[18px]" />
                        {t('post_content.footer.share_form.share_this_link')}
                      </span>
                    </SharePost>
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
                {/* ★ `xl:hidden`, NOT `md:hidden` (2026-08-13, audit §6.4 check e).
                    The rail that carries the suggestions only exists at `xl` and
                    up. While this said `md:hidden`, a reader between 768px and
                    1280px got them in the left nav column; now that the panel
                    lives in the right column, that band would have had no
                    suggestions at all. This strip is what falls BELOW the
                    article instead — full list, not the rail's capped five. */}
                <div className="xl:hidden">
                  {!!suggestionData ? (
                    <div className="mt-6 border-t border-border pt-4">
                      {/* ★ Was hardcoded English, outside i18n entirely (2026-08-17) —
                          a direct breach of this repo's own rule against inline
                          user-facing strings, and invisible to every locale. */}
                      <h2 className="mb-3 px-4 font-sans text-lg font-bold">{t('post_content.you_might_also_like')}</h2>
                      <SuggestionsList suggestions={suggestionData} variant="horizontal" />
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
          {/* ★ A CLIPPED THREAD SAYS SO (2026-08-13, adversarial review S3). The
              lite-reply merge is capped in three places — this page's parent list,
              the route's `MAX_PARENTS`, and a per-parent row cap in the SQL — and
              every one of them used to bind silently, so a thread that was missing
              replies looked exactly like a thread that had none. It is a small
              line deliberately: the replies that ARE here are correct and the
              chain half of the thread is untouched, so this is a footnote, not an
              error state. */}
          {!!postData && !nsfwHidden && liteRepliesTruncated ? (
            <p
              className="px-4 py-2 font-sans text-caption text-ink-10"
              data-testid="lite-replies-truncated"
            >
              {t('post_content.lite_replies_truncated')}
            </p>
          ) : null}
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
