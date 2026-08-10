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
import {
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
  return (await getChain()).api.bridge.unread_notifications({
    account
  });
};

export const getCommunities = async (
  sort: string,
  query?: string | null,
  observer: string = 'hive.blog'
): Promise<Community[] | null> => {
  return (await getChain()).api.bridge.list_communities({
    query,
    sort,
    observer
  });
};

export const getSubscriptions = async (account: string): Promise<string[][] | null> => {
  return (await getChain()).api.bridge.list_all_subscriptions({
    account
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
  return (await getChain()).api.bridge
    .get_ranked_posts({
      sort,
      start_author,
      start_permlink,
      limit,
      tag,
      observer
    })
    .then((resp) => {
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

const dropBannedEntries = (posts: Entry[]): Entry[] => posts.filter((post) => !isBannedEntry(post));

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
  return (await getChain()).api.bridge
    .get_post({
      author,
      permlink,
      observer
    })
    .then((resp) => {
      if (resp) {
        if (isBannedEntry(resp)) return null;
        return resolvePost(resp, observer);
      }

      return resp;
    });
};

export const getAccountPosts = async (
  sort: string,
  account: string,
  observer: string,
  start_author: string = '',
  start_permlink: string = '',
  limit: number = DATA_LIMIT
): Promise<Entry[] | null> => {
  // The whole account is banned: its Posts, Comments, Feed and Replies tabs are
  // all this one call, so answering "nothing here" once covers every one of them.
  if (isBannedAuthor(account)) return [];
  return (await getChain()).api.bridge
    .get_account_posts({
      sort,
      account,
      start_author,
      start_permlink,
      limit,
      observer
    })
    .then((resp) => {
      if (resp) {
        // `sort: 'feed'` mixes in the reblogs of everyone this account follows,
        // so even a clean account's page can carry a banned author's post.
        return resolvePosts(dropBannedEntries(resp), observer);
      }

      return resp;
    });
};

export const getFollowList = async (
  observer: string,
  follow_type: FollowListType
): Promise<IFollowList[]> => {
  return (await getChain()).api.bridge.get_follow_list({
    observer,
    follow_type
  });
};

export const getSubscribers = async (community: string): Promise<string[][] | null> => {
  return (await getChain()).api.bridge
    .list_subscribers({
      community
    })
    // Rows are `[account, role, title, joined]` — a banned account is not listed
    // as a member of anything.
    .then((resp) => (resp ? withoutBannedAuthors(resp, (row) => row[0]) : resp));
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
  return (await getChain()).api.bridge
    .account_notifications(params)
    .then((resp) => (resp ? withoutBannedAuthors(resp, notificationActor) : resp));
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

export const getCommunity = async (
  name: string,
  observer: string | undefined = ''
): Promise<Community | null> => {
  return (await getChain()).api.bridge.get_community({ name, observer });
};
export const getListCommunityRoles = async (community: string): Promise<string[][] | null> => {
  return (await getChain()).api.bridge
    .list_community_roles({ community })
    // Rows are `[account, role, title]`. A banned account keeps whatever role a
    // community gave it on chain; Lumen simply does not show it holding one.
    .then((resp) => (resp ? withoutBannedAuthors(resp, (row) => row[0]) : resp));
};

export const getDiscussion = async (
  author: string,
  permlink: string,
  observer?: string
): Promise<Record<string, Entry> | null> => {
  // A banned author's own post has no discussion to show.
  if (isBannedAuthor(author)) return null;
  return (await getChain()).api.bridge
    .get_discussion({
      author,
      permlink,
      observer
    })
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
