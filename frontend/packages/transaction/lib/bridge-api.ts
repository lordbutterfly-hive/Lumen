import { getLogger } from '@ui/lib/logging';
import {
  Community,
  Entry,
  FollowListType,
  IAccountNotification,
  IFollowList,
  IGetPostHeader,
  IUnreadNotifications
} from '@hive/common-hiveio-packages/wax';
import { getChain } from './chain';
import { withRetry } from './retry';
import { withHiveRetry } from '@smart-signer/lib/hive-network-error';
import {
  bannedAuthorList,
  hasBannedAuthors,
  isBannedAuthor,
  withoutBannedAuthors,
  withoutBannedDiscussion
} from '@ui/config/lists/banned-authors';

export const DATA_LIMIT = 20;

/**
 * ★ GLOBAL AUTHOR BAN — ENFORCED HERE, AT THE MOUTH OF THE PIPE.
 *
 * Every feed, profile, comment tree, search page and voter list in Lumen is
 * ultimately one of the functions in this file (and its sibling `hive-api.ts`)
 * returning chain data. Forty-odd modules in the blog app import from here.
 * Filtering at each of those call sites would mean forty chances to forget one,
 * and the one that got forgotten would be the surface the troll kept using.
 *
 * So the ban is applied to the RESULT of the chain call, before it is returned
 * to anything. A banned account's content does not exist as far as the rest of
 * the application is concerned — there is no code path that can opt out of this,
 * because there is no unfiltered accessor to opt into.
 *
 * The list is `@ui/config/lists/banned-authors`; see that file for how names are
 * configured. When the list is empty every helper below returns its input
 * unchanged, so this costs nothing until it is used.
 */
const logger = getLogger('bridge');
export const getPostHeader = async (author: string, permlink: string): Promise<IGetPostHeader> => {
  return (await getChain()).api.bridge.get_post_header({
    author,
    permlink
  });
};
export const getUnreadNotifications = async (account: string): Promise<IUnreadNotifications | null> => {
  // ★ A6 retry rollout (2026-08-18): idempotent read, single caller
  // (`/api/notifications/unread`), no existing retry anywhere in the chain.
  return withRetry(async () => (await getChain()).api.bridge.unread_notifications({ account }), {
    label: `unread_notifications(${account})`
  });
};

export const getCommunities = async (
  sort: string,
  query?: string | null,
  observer: string = 'hive.blog'
): Promise<Community[] | null> => {
  // ★ A6 retry rollout (2026-08-18): idempotent list read, single caller
  // (`/api/communities`).
  const communities = await withRetry(
    async () => (await getChain()).api.bridge.list_communities({ query, sort, observer }),
    { label: `list_communities(${sort})` }
  );
  // Same correction as `getCommunity` — this list is what feeds each card's
  // `.subscribers` figure on `/communities` (`communities-list-item.tsx`), so
  // it gets the identical fix rather than leaving that surface inconsistent
  // with the one just below it. `bannedSubscriptionCounts` is one round of
  // calls regardless of how many communities are in `communities`, so this
  // does not multiply cost per card.
  if (!communities) return communities;
  const banned = await bannedSubscriptionCounts();
  return communities.map((c) => withCorrectedSubscriberCount(c, banned));
};

export const getSubscriptions = async (account: string): Promise<string[][] | null> => {
  // ★ A6 retry rollout (2026-08-18): idempotent read. Used directly by
  // `/api/subscriptions` and internally by `bannedSubscriptionCounts` below —
  // both benefit, and neither has a competing retry of its own.
  return withRetry(async () => (await getChain()).api.bridge.list_all_subscriptions({ account }), {
    label: `list_all_subscriptions(${account})`
  });
};

export const getPostsRanked = async (
  sort: string,
  tag: string = '',
  start_author: string = '',
  start_permlink: string = '',
  observer: string,
  limit: number = DATA_LIMIT
): Promise<Entry[] | null> => {
  // ★ RETRY + NODE FAILOVER (2026-09-03), was ./retry withRetry (same-node, and
  // it treats a 429 as a final 4xx so it never retried one). withHiveRetry rotates
  // off a rate-limited api.hive.blog to a healthy node, so the feed fails over
  // instead of hard-failing. Sole caller (`/api/feed/for-you`) tolerates a
  // page-2+ failure and does not itself retry get_ranked_posts, so nothing doubles.
  return withHiveRetry(
    async () =>
      (await getChain()).api.bridge.get_ranked_posts({
        sort,
        start_author,
        start_permlink,
        limit,
        tag,
        observer
      }),
    `get_ranked_posts(${sort},${tag})`
  ).then((resp) => {
    // logger.info('getPostsRanked result: %o', resp);
    if (resp) {
      return resolvePosts(dropBannedEntries(resp), observer);
    }
    console.log('response', resp);

    return resp;
  });
};

/**
 * Is this entry a banned account's work, however it is dressed up?
 *
 * Two ways it can be, and both are checked:
 *   1. the account signed it            -> `author`
 *   2. someone else CROSS-POSTED it     -> `json_metadata.original_author`
 *
 * (2) matters more than it looks. A cross-post is a thin shell owned by whoever
 * re-shared it, carrying the original author's title and body; dropping only on
 * `author` would let any account republish the banned account's content into
 * every feed, byline and all, and the ban would read as broken to the one person
 * who asked for it.
 */
const isBannedEntry = (post: Entry): boolean =>
  isBannedAuthor(post?.author) || isBannedAuthor(post?.json_metadata?.original_author);

/**
 * The mirror image of the cross-post case above, and it has to be handled the
 * opposite way.
 *
 * A cross-post SHELL is dropped whole because the shell's content — title,
 * body, everything the reader sees — belongs to the banned account; keeping
 * it would let that account's writing reach every feed under someone else's
 * signature. A reblog is the reverse relationship: `reblogged_by` names
 * whoever chose to AMPLIFY the post, not whoever wrote it. The post itself
 * still belongs to its real `author`, who is not banned (`isBannedEntry`
 * already dropped this entry if it were) and did nothing wrong by having a
 * banned account reblog them. Dropping the post here would ban the reader
 * from the WRONG person's work — the one thing this list is not allowed to
 * do (see the file header).
 *
 * So only the credit line comes off. `post-list-item.tsx` and
 * `medium-post-card.tsx` both render `reblogged_by[0]` as a clickable
 * "Reblogged by X" pointing straight at that account's profile — exactly the
 * visibility and promotion the ban exists to deny — while leaving the post
 * itself, and its legitimate author, fully intact. Mirrors `getRebloggedBy`
 * in `hive-api.ts`, which already strips banned names out of the same
 * relationship read from the other direction (the dedicated "who reblogged
 * this post" list); this is the feed-card side of the identical rule.
 */
const withoutBannedReblogger = (post: Entry): Entry => {
  if (!post.reblogged_by || post.reblogged_by.length === 0) return post;
  const credited = withoutBannedAuthors(post.reblogged_by, (name) => name);
  if (credited.length === post.reblogged_by.length) return post;
  // Empty out entirely rather than leave `[]` — every render site already
  // guards on `post.reblogged_by` being present/non-empty before showing the
  // credit line, so `undefined` is what makes that line disappear.
  return { ...post, reblogged_by: credited.length > 0 ? credited : undefined };
};

const dropBannedEntries = (posts: Entry[]): Entry[] =>
  posts.filter((post) => !isBannedEntry(post)).map(withoutBannedReblogger);

const resolvePosts = (posts: Entry[], observer: string): Promise<Entry[]> => {
  const promises = posts.map((p) => resolvePost(p, observer));

  return Promise.all(promises);
};

const resolvePost = (post: Entry, observer: string): Promise<Entry> => {
  const { json_metadata: json } = post;

  if (json.original_author && json.original_permlink && json.tags && json.tags[0] === 'cross-post') {
    return getPost(json.original_author, json.original_permlink, observer)
      .then((resp) => {
        if (resp) {
          return {
            ...post,
            original_entry: resp
          };
        }

        return post;
      })
      .catch(() => {
        return post;
      });
  }

  return new Promise((resolve) => {
    resolve(post);
  });
};

/**
 * ★ DELIBERATELY NOT WRAPPED IN `withRetry` (A6 retry rollout, 2026-08-18).
 *
 * This is the one shared read that already has a caller-level retry:
 * `/api/feed/for-you` fans this out to ~30 posts per page and wraps each call
 * in its own "ONE retry, short backoff" (see that route's comment on why it
 * stops at one — more would turn a real outage into a slow one, multiplied
 * across ~30 concurrent posts). Adding a second, independent retry budget here
 * would nest under that one and multiply attempts (up to 3x the caller's own
 * 2x) across every one of those ~30 calls at once.
 *
 * `/api/post-status` and `/api/resolve-post/[user]/[permlink]` — the other two
 * callers — have no such conflict and get `withRetry` wired at their own route
 * level instead, around this same function, so they still benefit.
 */
export const getPost = async (
  author: string = '',
  permlink: string = '',
  observer: string = ''
): Promise<Entry | null> => {
  // Cheapest possible short-circuit: a banned author's post is "not found", and
  // we do not spend an upstream round trip discovering that. Returning null (the
  // same thing a genuinely missing post returns) is what makes the post page
  // 404 without any change to the page itself — `PostPage` already calls
  // `notFound()` when there is no post.
  if (isBannedAuthor(author)) return null;
  // ★ RETRY + NODE FAILOVER (2026-09-03). This was a bare upstream call: a 429
  // from api.hive.blog (the single configured node routinely rate-limits us)
  // hard-failed the whole post page with no attempt on a healthy node, even
  // though openhive/deathwing/mahdiyari sit in the rotation. `withHiveRetry`
  // classifies a 429 as retryable ("possible network or CORS error") and, after
  // one same-node retry, rotates to the next node — unlike `./retry`'s withRetry,
  // which treats any 4xx (429 included) as a final answer and never failovers.
  const resp = await withHiveRetry(
    async () => (await getChain()).api.bridge.get_post({ author, permlink, observer }),
    `get_post(${author}/${permlink})`
  );
  if (resp) {
    if (isBannedEntry(resp)) return null;
    return resolvePost(withoutBannedReblogger(resp), observer);
  }
  return resp;
};

/**
 * ★ DELIBERATELY NOT WRAPPED IN `withRetry` (A6 retry rollout, 2026-08-18).
 *
 * `streak/[user]/route.ts`'s `walkFeed` calls this inside its own
 * `withTimeout(..., Math.min(CALL_TIMEOUT_MS, remaining), ...)` — a hand-rolled,
 * shrinking wall-clock budget across up to `MAX_PAGES` sequential calls, built
 * (per that file's own history) specifically to stop a slow/flaky node from
 * being misread as "this account has no activity". `withTimeout` cannot cancel
 * the underlying call, so adding a retry loop underneath would only prolong
 * work that route has already decided to stop waiting on, not speed anything up.
 *
 * `/api/account-posts` and `/api/lite/feed/following` — the other two callers —
 * have no such budget and get `withRetry` wired at their own route level
 * instead, around this same function.
 */
export interface AccountPostsPage {
  entries: Entry[] | null;
  /**
   * How many entries the NODE returned, before `dropBannedEntries` ran.
   *
   * ★ THIS IS WHAT "WAS THE PAGE FULL" MUST BE ANSWERED FROM (2026-08-23). A caller
   * that pages until a short page arrives cannot use `entries.length`, because every
   * filter between the node and the caller shrinks it: `dropBannedEntries` here, the
   * profile owner's blocks in `/api/account-posts`, then the viewer's own list. A page
   * of 20 carrying one banned author arrives as 19 and reads as the end of the account,
   * with the rest of its posts unreachable. This count never passes through a filter.
   */
  rawCount: number;
  /**
   * The cursor for the next page, taken from the RAW page's last entry.
   *
   * Same reason as `rawCount`: if every entry on a page is filtered out there is no
   * surviving entry to build a cursor from, and paging stops dead with content behind
   * it. Null only when the node genuinely returned nothing.
   */
  rawCursor: { author: string; permlink: string } | null;
}

/**
 * `getAccountPosts` plus the pre-filter page size. Same call, same filtering; it just
 * also reports what the node actually returned, which the filtered array can no longer
 * tell you. Use this wherever a cursor or a "load more" decision is being made.
 */
export const getAccountPostsPage = async (
  sort: string,
  account: string,
  observer: string,
  start_author: string = '',
  start_permlink: string = '',
  limit: number = DATA_LIMIT
): Promise<AccountPostsPage> => {
  // The whole account is banned: its Posts, Comments, Feed and Replies tabs are
  // all this one call, so answering "nothing here" once covers every one of them.
  // `rawCount: 0` is the truth here — there is no next page to walk to.
  if (isBannedAuthor(account)) return { entries: [], rawCount: 0, rawCursor: null };
  // ★ RETRY + NODE FAILOVER (2026-09-03). This was a bare call with no retry at
  // all — the Following/Posts/Comments tabs are all this one call, and a 429 (or a
  // dead node) hard-failed the whole tab (the "Lumen crashes when I click
  // Following" report). withHiveRetry rotates off the bad node to a healthy one.
  const resp = await withHiveRetry(
    async () =>
      (await getChain()).api.bridge.get_account_posts({
        sort,
        account,
        start_author,
        start_permlink,
        limit,
        observer
      }),
    `get_account_posts(${sort},${account})`
  );
  if (!resp) return { entries: resp ?? null, rawCount: 0, rawCursor: null };
  // `sort: 'feed'` mixes in the reblogs of everyone this account follows,
  // so even a clean account's page can carry a banned author's post.
  const rawLast = resp.length > 0 ? resp[resp.length - 1] : null;
  return {
    entries: await resolvePosts(dropBannedEntries(resp), observer),
    rawCount: resp.length,
    rawCursor: rawLast ? { author: rawLast.author, permlink: rawLast.permlink } : null
  };
};

export const getAccountPosts = async (
  sort: string,
  account: string,
  observer: string,
  start_author: string = '',
  start_permlink: string = '',
  limit: number = DATA_LIMIT
): Promise<Entry[] | null> =>
  (await getAccountPostsPage(sort, account, observer, start_author, start_permlink, limit)).entries;

export const getFollowList = async (
  observer: string,
  follow_type: FollowListType
): Promise<IFollowList[]> => {
  // ★ A6 retry rollout (2026-08-18): idempotent read, single caller (`/api/follow-list`).
  // ★ withHiveRetry (failover), not withRetry: a 429 on the configured node must
  // fail over to a healthy one, or the mute/blacklist read fails and the post
  // page serves no thread (see the prod incident). withRetry would not retry a 429
  // and would not rotate nodes.
  return withHiveRetry(
    async () => (await getChain()).api.bridge.get_follow_list({ observer, follow_type }),
    `get_follow_list(${observer})`
  );
};

export const getSubscribers = async (community: string): Promise<string[][] | null> => {
  // ★ A6 retry rollout (2026-08-18): idempotent read, single caller
  // (`/api/community/subscribers`).
  return withRetry(async () => (await getChain()).api.bridge.list_subscribers({ community }), {
    label: `list_subscribers(${community})`
  }).then((resp) =>
    // Rows are `[account, role, title, joined]` — a banned account is not listed
    // as a member of anything.
    resp ? withoutBannedAuthors(resp, (row) => row[0]) : resp
  );
};

export const getAccountNotifications = async (
  account: string,
  lastId: number | null = null,
  limit = 50
): Promise<IAccountNotification[] | null> => {
  const params: { account: string; last_id?: number; limit: number } = {
    account,
    limit
  };

  if (lastId) {
    params.last_id = lastId;
  }
  // ★ A6 retry rollout (2026-08-18): idempotent read, single caller
  // (`/api/notifications/account`).
  return withRetry(async () => (await getChain()).api.bridge.account_notifications(params), {
    label: `account_notifications(${account})`
  }).then((resp) => (resp ? withoutBannedAuthors(resp, notificationActor) : resp));
};

/**
 * Who a notification is ABOUT.
 *
 * `IAccountNotification` has no author field — the actor is written into the
 * human-readable `msg` ("@troll replied to your post") and into `url`
 * ("@troll/permlink" or "category/@troll/permlink"). Both are read, because a
 * reply notification and a vote notification do not put it in the same place,
 * and a troll who can still ring your bell fifty times an hour has not been
 * banned in any sense the person being rung would recognise.
 */
const notificationActor = (n: IAccountNotification): string => {
  const fromMsg = /^@([a-z0-9.-]{3,16})\b/.exec(n?.msg ?? '')?.[1];
  if (fromMsg) return fromMsg;
  return /@([a-z0-9.-]{3,16})\//.exec(n?.url ?? '')?.[1] ?? '';
};

/**
 * How many of the (small, fixed) banned accounts subscribe to each community,
 * keyed by community name — computed by walking the BAN LIST once, not by
 * walking any community's subscriber list.
 *
 * Same arithmetic-mismatch class as `dropBannedEntries` above: `get_community`
 * returns `.subscribers` as a raw Hivemind count, but `getSubscribers` below
 * filters the LIST that same number is displayed next to (`SubsListDialog`).
 * A banned account subscribed to a community makes the two disagree.
 *
 * The reason this is fixable where `post.stats.total_votes` (documented,
 * deliberately left alone — see that predicate's own comment) is not: voters
 * are unbounded per POST and there is no cheap way to ask "did banned account
 * X vote on post Y" without paging the vote list. Subscriptions run the other
 * way. `bridge.list_subscribers` is capped at ~100 rows per call and sorted
 * alphabetically — a community with thousands of subscribers (confirmed live:
 * hive-148441 has 24,931) cannot be fully paged on every page load. But
 * `bridge.list_all_subscriptions` per ACCOUNT is not paginated in this
 * codebase's use of it (`getSubscriptions`, above) and the ban list itself is
 * tiny and fixed — 6 names at the time of writing. So instead of paging every
 * community looking for 6 names, this pages the 6 names looking for every
 * community they are in: one `list_all_subscriptions` call per banned
 * account, in parallel, independent of how large the community (or how many
 * communities the caller is about to render) is.
 */
/**
 * ★★★ MEMOISED (2026-08-13, browser audit §2.1 — the `/roles/[tag]` TTFB item).
 *
 * This correction is invisible at its call site and it is not cheap: `getCommunity`
 * reads as ONE chain call and actually makes **seven** — `bridge.get_community`
 * plus one `bridge.list_all_subscriptions` per banned account (six configured
 * here: kgakakillerg, bpcvoter, bpcvoter1-4). Every community, topic and roles
 * page server-renders `getCommunity` TWICE (once in `generateMetadata`, once in
 * the community layout's `PrefetchComponent`), so a community page was paying
 * **fourteen** upstream round trips before its first byte, twelve of which
 * recomputed the same answer. Measured against api.hive.blog on 2026-08-13, a
 * single `list_all_subscriptions` is 378-795ms.
 *
 * What is being cached is the safest thing in this file to cache. The INPUT is
 * the ban list — a compile-time env value that cannot change without a restart —
 * and each banned account's own community subscriptions, which are public chain
 * state that changes when a troll joins a community. The OUTPUT is used for one
 * thing only: subtracting banned members from a displayed subscriber COUNT, a
 * correction that already fails open to the raw number on any error. Five minutes
 * of staleness there is a subscriber count that is at most six too high for five
 * minutes; the alternative was six chain calls per community lookup, forever.
 *
 * Deliberately a local memo rather than `apps/blog/lib/server-read-cache.ts`: a
 * package must not import from an app. It is one value, not a keyed cache, so it
 * needs no eviction. A failed read is NOT stored — `Promise.all` catches each call
 * individually and a partial result would otherwise be frozen in for five minutes.
 */
const BANNED_SUBSCRIPTIONS_TTL_MS = 300_000;
let bannedSubscriptionsMemo: { counts: Map<string, number>; expiresAt: number } | null = null;
let bannedSubscriptionsInFlight: Promise<Map<string, number>> | null = null;

const bannedSubscriptionCounts = async (): Promise<Map<string, number>> => {
  if (!hasBannedAuthors()) return new Map();

  const now = Date.now();
  if (bannedSubscriptionsMemo && bannedSubscriptionsMemo.expiresAt > now) {
    return bannedSubscriptionsMemo.counts;
  }
  // Two page renders land in the same millisecond on every community route (the
  // metadata pass and the layout pass) — without this they both miss and both
  // fire six calls.
  if (bannedSubscriptionsInFlight) return bannedSubscriptionsInFlight;

  bannedSubscriptionsInFlight = (async () => {
    try {
      const counts = new Map<string, number>();
      const lists = await Promise.all(
        bannedAuthorList().map((name) => getSubscriptions(name).catch(() => null))
      );
      // A rejected lookup comes back as `null` above, so a node hiccup would
      // otherwise be memoised as "this troll is in no communities" for 5 minutes.
      const complete = lists.every((rows) => rows !== null);
      for (const rows of lists) {
        for (const row of rows ?? []) counts.set(row[0], (counts.get(row[0]) ?? 0) + 1);
      }
      if (complete) {
        bannedSubscriptionsMemo = { counts, expiresAt: Date.now() + BANNED_SUBSCRIPTIONS_TTL_MS };
      }
      return counts;
    } finally {
      bannedSubscriptionsInFlight = null;
    }
  })();
  return bannedSubscriptionsInFlight;
};

/** Apply the correction above to one `Community`'s `.subscribers` count. */
const withCorrectedSubscriberCount = (community: Community, banned: Map<string, number>): Community => {
  const drop = banned.get(community.name) ?? 0;
  return drop === 0 ? community : { ...community, subscribers: Math.max(0, community.subscribers - drop) };
};

export interface GetCommunityOptions {
  /**
   * Apply the banned-subscriber-count correction above before returning.
   * Defaults to `true` so every caller that already exists keeps the exact
   * number it always got.
   *
   * ★ SET `false` ONLY WHEN THE CALLER NEVER SHOWS `.subscribers` (2026-09-05,
   * post-page TTFB pass). `getCommunity` had no way for a caller to decline
   * this correction, so every call paid whatever `bannedSubscriptionCounts()`
   * cost at that moment — cheap on its warm 5-minute cache, but the miss is
   * six parallel `list_all_subscriptions` calls against a node that answers
   * 378-795ms each (see that function's own comment; measured 578-1195ms for
   * the batch). The post page's `Promise.allSettled` awaits `getCommunityCached`
   * alongside the post/discussion reads, so landing on that miss stalled the
   * ENTIRE post render behind a number the post page never displays —
   * `content.tsx` reads `communityData` only for `flag_text` and title
   * context, never `.subscribers` (rendered exclusively by
   * `community-description.tsx`/`community-simple-description.tsx`, the
   * community's OWN layout, not the post page). `false` returns the raw
   * Hivemind count — the exact number this correction already falls open to
   * on any upstream error (see `bannedSubscriptionCounts`), so a caller that
   * opts out is indistinguishable from one that opted in and hit that error
   * path.
   */
  correctSubscribers?: boolean;
}

export const getCommunity = async (
  name: string,
  observer: string | undefined = '',
  { correctSubscribers = true }: GetCommunityOptions = {}
): Promise<Community | null> => {
  // ★ A6 (2026-08-18): a dropped socket to a public Hive node used to become a 502 on the
  // reader's community page. `withRetry` retries transport faults and 5xx only — a "no
  // such community" answer is returned, not retried. See lib/retry.ts.
  // ★ withHiveRetry (failover), not withRetry: fail over on a 429/transport fault
  // to a healthy node rather than hard-failing the community read.
  const community = await withHiveRetry(
    async () => (await getChain()).api.bridge.get_community({ name, observer }),
    `get_community(${name})`
  );
  if (!community) return community;
  if (!correctSubscribers) return community;
  return withCorrectedSubscriberCount(community, await bannedSubscriptionCounts());
};
/**
 * ★ `limit` (2026-08-13, browser audit §2.4/§5.2). This never passed one, so it
 * always got `bridge.list_community_roles`'s DEFAULT of 50 rows. Measured against
 * api.hive.blog: `hive-141359` has **593** role rows, of which 50 were reaching
 * the app — a silent truncation on the one page (`/roles/[tag]`) whose whole job
 * is to list and edit them, so a moderator could not see, let alone change, the
 * role of anyone outside the first fifty. Rows come back ordered by role rank
 * (owner, admin/mod, member, muted) and then alphabetically, so the truncation
 * never hid a moderator in practice — but that is an ordering accident, not a
 * guarantee, and any community with more than 50 privileged accounts would have
 * lost its own mods' tools.
 *
 * `limit` is real on the wire (verified live: `{community, limit: 1000}` returns
 * every row, and returns only 72 for `hive-139531`, which has 72) but is missing
 * from the `list_community_roles` signature in
 * `packages/common-hiveio-packages/src/wax/extended-hive.chain.ts`, which declares
 * only `{ community: string }`. Passed through a locally-narrowed view of the same
 * call rather than widening a shared chain type from here. Optional so no existing
 * caller changes behaviour by accident.
 */
type ListCommunityRolesParams = { community: string; limit?: number };

export const getListCommunityRoles = async (
  community: string,
  limit?: number
): Promise<string[][] | null> => {
  const chain = await getChain();
  const listRoles = chain.api.bridge.list_community_roles as unknown as (
    params: ListCommunityRolesParams
  ) => Promise<string[][] | null>;
  // ★ A6 retry rollout (2026-08-18): idempotent read, single caller
  // (`/api/community-roles`, itself already sitting behind a `cachedRead` memo).
  return withRetry(() => listRoles(limit === undefined ? { community } : { community, limit }), {
    label: `list_community_roles(${community})`
  }).then((resp) =>
    // Rows are `[account, role, title]`. A banned account keeps whatever role a
    // community gave it on chain; Lumen simply does not show it holding one.
    resp ? withoutBannedAuthors(resp, (row) => row[0]) : resp
  );
};

export const getDiscussion = async (
  author: string,
  permlink: string,
  observer?: string
): Promise<Record<string, Entry> | null> => {
  // A banned author's own post has no discussion to show.
  if (isBannedAuthor(author)) return null;
  // ★ A6 retry rollout (2026-08-18): idempotent read, single caller (`/api/discussion`,
  // which may call this twice for a Lumen permlink fallback — both calls benefit,
  // neither has a competing retry).
  // ★ withHiveRetry (failover), not withRetry: the comment tree read must rotate
  // off a rate-limited node instead of hard-failing (prod: "Error fetching
  // discussion data" on a 429 with no failover).
  return withHiveRetry(
    async () => (await getChain()).api.bridge.get_discussion({ author, permlink, observer }),
    `get_discussion(${author}/${permlink})`
  )
    // ★ THE COMMENT TREE IS THE POINT. A troll's replies under OTHER people's
    // posts are the surface he actually lives on — he does not need his own post
    // to reach every reader on the site, he needs yours. `withoutBannedDiscussion`
    // removes his nodes AND the subtree hanging off them, and repairs the parent
    // `replies` arrays so the client is not handed dangling references.
    //
    // Note what this replaces: today he is missing from most threads only because
    // Lumen passes `observer: 'hive.blog'` and Hivemind quietly applies THAT
    // account's mute list. That is a third party's moderation decision, on a
    // third party's schedule — and it evaporates the moment a signed-in reader
    // becomes the observer, which is every logged-in Hive user on the site.
    .then((resp) => withoutBannedDiscussion(resp) ?? null);
};
