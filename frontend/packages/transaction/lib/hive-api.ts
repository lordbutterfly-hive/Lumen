import {
  AccountFollowStats,
  AccountProfile,
  FullAccount,
  Entry,
  IAccountReputations,
  IFeedHistory,
  IFollow,
  IVote,
  IVoteListItem
} from '@hive/common-hiveio-packages/wax';
import { GetDynamicGlobalPropertiesResponse } from '@hiveio/wax';
import { getChain } from './chain';
import { withHiveRetry } from '@smart-signer/lib/hive-network-error';
import { bannedAuthorList, hasBannedAuthors } from '@ui/config/lists/banned-authors';
import { ApiAccount, IManabarData } from '@hiveio/wax';
import { DATA_LIMIT } from './bridge-api';
import { isBannedAuthor, withoutBannedAuthors } from '@ui/config/lists/banned-authors';

interface ISingleManabar {
  max: string;
  current: string;
  percentageValue: number;
  cooldown: Date;
}
interface Manabar {
  upvote: ISingleManabar;
  downvote: ISingleManabar;
  rc: ISingleManabar;
}

interface IManabars {
  upvote: IManabarData;
  downvote: IManabarData;
  rc: IManabarData;
  upvoteCooldown: Date;
  downvoteCooldown: Date;
  rcCooldown: Date;
}

const PERCENT_VALUE_DOUBLE_PRECISION = 100;
const ONE_HUNDRED_PERCENT = BigInt(100) * BigInt(PERCENT_VALUE_DOUBLE_PRECISION);

export const getManabars = async (accountName: string): Promise<IManabars | null> => {
  try {
    const chain = await getChain();

    const [dgpo, {
      accounts: [account]
    }, {
      rc_accounts: [rcAccount]
    }] = await Promise.all([
      chain.api.database_api.get_dynamic_global_properties({}),
      chain.api.database_api.find_accounts({
        accounts: [accountName],
        delayed_votes_active: false
      }),
      chain.api.rc_api.find_rc_accounts({ accounts: [ accountName ] })
    ]);

    if (!account || !rcAccount) {
      return null;
    }

    const time = new Date(`${dgpo.time}Z`).getTime() / 1000;

    const upvoteCooldown = new Date(chain.calculateManabarFullRegenerationTime(
      time,
      account.post_voting_power.amount,
      account.voting_manabar.current_mana,
      account.voting_manabar.last_update_time
    ) * 1000);

    // This code is copied from Wax repository. We should implement an easier way to manually calculate multiple manabars in the future.
    let max = BigInt(account.post_voting_power.amount);
    const downvotePoolPercent = BigInt(dgpo.downvote_pool_percent);
    if(max / ONE_HUNDRED_PERCENT > ONE_HUNDRED_PERCENT)
      max = (max / ONE_HUNDRED_PERCENT) * downvotePoolPercent;
    else
      max = (max * downvotePoolPercent) / ONE_HUNDRED_PERCENT;

    const downvoteCooldown = new Date(chain.calculateManabarFullRegenerationTime(
      time,
      max,
      account.downvote_manabar.current_mana,
      account.downvote_manabar.last_update_time
    ) * 1000);
    const rcCooldown = new Date(chain.calculateManabarFullRegenerationTime(
      time,
      rcAccount.max_rc,
      rcAccount.rc_manabar.current_mana,
      rcAccount.rc_manabar.last_update_time
    ) * 1000);
    const upvote = chain.calculateCurrentManabarValue(
      time,
      account.post_voting_power.amount,
      account.voting_manabar.current_mana,
      account.voting_manabar.last_update_time
    );
    const downvote = chain.calculateCurrentManabarValue(
      time,
      max,
      account.downvote_manabar.current_mana,
      account.downvote_manabar.last_update_time
    );
    const rc = chain.calculateCurrentManabarValue(
      time,
      rcAccount.max_rc,
      rcAccount.rc_manabar.current_mana,
      rcAccount.rc_manabar.last_update_time
    );

    return {
      upvote,
      upvoteCooldown,
      downvote,
      downvoteCooldown,
      rc,
      rcCooldown
    };
  } catch (error) {
    console.error(error);
    return null;
  }
};
export const getManabar = async (accountName: string): Promise<Manabar | null> => {
  const manabars = await getManabars(accountName!);
  if (!manabars) return null;
  const { upvote, upvoteCooldown, downvote, downvoteCooldown, rc, rcCooldown } = manabars;

  const processedManabars = {
    upvote: {
      cooldown: upvoteCooldown,
      max: upvote.max.toString(),
      current: upvote.current.toString(),
      percentageValue: upvote.percent
    },
    downvote: {
      cooldown: downvoteCooldown,
      max: downvote.max.toString(),
      current: downvote.current.toString(),
      percentageValue: downvote.percent
    },
    rc: {
      cooldown: rcCooldown,
      max: rc.max.toString(),
      current: rc.current.toString(),
      percentageValue: rc.percent
    }
  };
  return processedManabars;
};

export const getAccounts = async (usernames: string[]): Promise<FullAccount[]> => {
  /**
   * ★★★ RETRY AND FAIL OVER TO ANOTHER HIVE NODE (2026-08-18).
   *
   * Before this, retry-and-failover existed in the codebase but was wired into
   * three call sites, all sign-in. Every content read — this one included — went
   * to a single node with no retry, so one unreachable node meant one failed
   * read and a reader with no way to recover it.
   *
   * `withHiveRetry` retries ONLY when the node could not be reached; a node that
   * answers "no such account" has done its job and is never asked twice.
   */
  const result = await withHiveRetry(
    async () =>
      (await getChain()).api.database_api.find_accounts({
        accounts: usernames,
        delayed_votes_active: false
      }),
    'database_api.find_accounts'
  );

  return result.accounts.map((x) => {
    const account: FullAccount = {
      name: x.name,
      owner: x.owner,
      active: x.active,
      posting: x.posting,
      memo_key: x.memo_key,
      post_count: x.post_count,
      created: x.created,
      posting_json_metadata: x.posting_json_metadata,
      last_vote_time: x.last_vote_time,
      last_post: x.last_post,
      json_metadata: x.json_metadata,
      reward_hive_balance: x.reward_hive_balance,
      reward_hbd_balance: x.reward_hbd_balance,
      reward_vesting_hive: x.reward_vesting_hive,
      governance_vote_expiration_ts: x.governance_vote_expiration_ts,
      reward_vesting_balance: x.reward_vesting_balance,
      balance: x.balance,
      hbd_balance: x.hbd_balance,
      savings_balance: x.savings_balance,
      savings_hbd_balance: x.savings_hbd_balance,
      savings_hbd_last_interest_payment: x.hbd_last_interest_payment,
      savings_hbd_seconds_last_update: x.savings_hbd_seconds_last_update,
      savings_hbd_seconds: x.savings_hbd_seconds,
      next_vesting_withdrawal: x.next_vesting_withdrawal,
      vesting_shares: x.vesting_shares,
      delegated_vesting_shares: x.delegated_vesting_shares,
      received_vesting_shares: x.received_vesting_shares,
      vesting_withdraw_rate: x.vesting_withdraw_rate,
      to_withdraw: x.to_withdraw,
      withdrawn: x.withdrawn,
      proxy: x.proxy,
      proxied_vsf_votes: x.proxied_vsf_votes,
      voting_manabar: x.voting_manabar,
      downvote_manabar: x.downvote_manabar,
      __loaded: true
    };

    let profile: AccountProfile | undefined;

    try {
      profile = JSON.parse(x.posting_json_metadata!).profile;
    } catch (e) {}

    if (!profile) {
      try {
        profile = JSON.parse(x.json_metadata!).profile;
      } catch (e) {}
    }

    if (!profile) {
      profile = {
        about: '',
        cover_image: '',
        location: '',
        name: '',
        profile_image: '',
        website: ''
      };
    }

    return { ...account, profile };
  });
};

export const getAccount = (username: string): Promise<FullAccount> =>
  getAccounts([username]).then((resp) => resp[0]);

/**
 * How many banned accounts sit on each side of this account's follow graph.
 *
 * ★ THE COUNT-VS-LIST MISMATCH, on the most-visited surface there is.
 * `bridge.get_profile().stats` returns `followers`/`following` as raw Hivemind
 * counts that include banned accounts, while `getFollowers`/`getFollowing`
 * below filter the LIST those numbers are printed next to. So a profile header
 * said "84 Followers" over a list rendering 83.
 *
 * Fixed the same way `bannedSubscriptionCounts` in `bridge-api.ts` fixes the
 * community-subscriber version, and for the same reason it works there and not
 * for `post.stats.total_votes`: the asymmetry. Voters are unbounded per post
 * with no cheap way to ask "did X vote here". A follow edge IS directly
 * askable — `get_relationship_between_accounts` answers one edge in one small
 * call — and the ban list is tiny and fixed (6 names at the time of writing).
 * So this asks the ban list about this account rather than paging this
 * account's followers looking for the ban list.
 *
 * Cost is `2 * banList.length` small parallel calls, only on profile reads,
 * only when a ban list is configured, behind the same cache as the profile
 * itself (`getAccountFullCached`).
 *
 * Fails OPEN to the raw count on any error: a wrong-by-one follower number is
 * a cosmetic defect, and a profile page that will not load is not.
 */
/**
 * ★★★ MEMOISED (2026-08-13, browser audit §1.5). The cost estimate in the doc
 * above — "2 * banList.length small parallel calls ... behind the same cache as
 * the profile itself" — turned out to be the load-bearing claim, and the second
 * half of it was not true everywhere. Measured in a browser on `/wallet`:
 * **twelve** `bridge.get_relationship_between_accounts` requests, 140-280ms each,
 * on one page load. They are invisible at the call site — `useWalletAccount`
 * asked for `getAccountFull(username)` and got nineteen network requests — and
 * they ride along with EVERY `getAccountFull`, which is the most-used read in the
 * app (`/api/account`, every profile header, every hover card, the wallet).
 *
 * The `getAccountFullCached` the doc refers to does not cover the callers that
 * matter here, so the correction is memoised at its own level instead. Same
 * reasoning as `bannedSubscriptionCounts` in `bridge-api.ts`: the input is a
 * compile-time ban list plus one public follow edge per banned account, and the
 * output only ADJUSTS A DISPLAYED FOLLOWER COUNT — a correction that already
 * fails open to the raw number. Five minutes of staleness is a follower count
 * that can be off by at most the size of the ban list, for five minutes.
 *
 * Bounded and keyed by account, unlike its sibling: this one takes an argument.
 * Nothing is stored when any edge lookup failed, so a node hiccup cannot freeze
 * "no banned followers" in for five minutes.
 */
const BANNED_EDGES_TTL_MS = 300_000;
const BANNED_EDGES_MAX = 500;
const bannedEdgesMemo = new Map<string, { value: { followers: number; following: number }; expiresAt: number }>();
const bannedEdgesInFlight = new Map<string, Promise<{ followers: number; following: number }>>();

const bannedFollowEdges = async (username: string): Promise<{ followers: number; following: number }> => {
  if (!hasBannedAuthors()) return { followers: 0, following: 0 };

  const hit = bannedEdgesMemo.get(username);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const pending = bannedEdgesInFlight.get(username);
  if (pending) return pending;

  const promise = (async () => {
    try {
      const names = bannedAuthorList();
      const chain = await getChain();
      const edge = (follower: string, followed: string) =>
        chain.api.bridge.get_relationship_between_accounts([follower, followed]).catch(() => null);
      const [inbound, outbound] = await Promise.all([
        // banned -> username: inflates this account's FOLLOWER count
        Promise.all(names.map((name) => edge(name, username))),
        // username -> banned: inflates this account's FOLLOWING count
        Promise.all(names.map((name) => edge(username, name)))
      ]);
      const value = {
        followers: inbound.filter((r) => r?.follows).length,
        following: outbound.filter((r) => r?.follows).length
      };
      if ([...inbound, ...outbound].every((r) => r !== null)) {
        // Oldest-first eviction; this is a burst collapser, not an LRU.
        if (bannedEdgesMemo.size >= BANNED_EDGES_MAX) {
          const oldest = bannedEdgesMemo.keys().next().value;
          if (oldest !== undefined) bannedEdgesMemo.delete(oldest);
        }
        bannedEdgesMemo.set(username, { value, expiresAt: Date.now() + BANNED_EDGES_TTL_MS });
      }
      return value;
    } finally {
      bannedEdgesInFlight.delete(username);
    }
  })();

  bannedEdgesInFlight.set(username, promise);
  return promise;
};

/**
 * Fetches follow stats and reputation from bridge.get_profile.
 * Returns both values from a single API call.
 */
export const getProfileInfo = async (
  username: string
): Promise<{ follow_stats: AccountFollowStats; reputation: number }> => {
  const profile = await (await getChain()).api.bridge.get_profile({ account: username });
  if (!profile || !profile.stats) {
    return {
      follow_stats: {
        account: username,
        follower_count: 0,
        following_count: 0
      },
      reputation: 25
    };
  }
  const banned = await bannedFollowEdges(username).catch(() => ({ followers: 0, following: 0 }));
  return {
    follow_stats: {
      account: username,
      follower_count: Math.max(0, profile.stats.followers - banned.followers),
      following_count: Math.max(0, profile.stats.following - banned.following)
    },
    reputation: profile.reputation ?? 25
  };
};

export const getAccountFull = (username: string): Promise<FullAccount> =>
  getAccount(username).then(async (account) => {
    let follow_stats: AccountFollowStats | undefined;
    let reputation: number | undefined;
    try {
      const profileInfo = await getProfileInfo(username);
      follow_stats = profileInfo.follow_stats;
      reputation = profileInfo.reputation;
    } catch (e) {}
    return { ...account, follow_stats, reputation };
  });

export const getFollowCount = async (username: string): Promise<AccountFollowStats> => {
  const profileInfo = await getProfileInfo(username);
  return profileInfo.follow_stats;
};

/**
 * Returns list of accounts that reblogged given post, defined by tuple
 * `[author: string, permlink: string]`.
 *
 * @param author
 * @param permlink
 * @returns
 */
export const getRebloggedBy = async (author: string, permlink: string): Promise<string[]> => {
  const rebloggers = await (await getChain()).api.condenser_api.get_reblogged_by([ author, permlink ]);
  // A banned account is not credited with amplifying anybody's post, and does not
  // appear in the "reblogged by" attribution list.
  return withoutBannedAuthors(rebloggers, (name) => name);
};

export const getFeedHistory = async (): Promise<IFeedHistory> => {
  return (await getChain()).api.database_api.get_feed_history();
};

// See https://developers.hive.io/apidefinitions/#database_api.list_votes
export const getListVotesByCommentVoter = async (
  start: [string, string, string] | null, // should be [author, permlink, voter]
  limit: number
): Promise<{ votes: IVoteListItem[] }> => {
  return (await getChain()).api.database_api.list_votes({ start, limit, order: 'by_comment_voter' });
};

export const getFindAccounts = async (username: string): Promise<{ accounts: ApiAccount[] }> => {
  return (await getChain()).api.database_api.find_accounts({
    accounts: [username],
    delayed_votes_active: false
  });
};

export interface IGetFollowParams {
  account: string;
  start: string | null;
  type: string;
  limit: number;
}

export const DEFAULT_PARAMS_FOR_FOLLOW: IGetFollowParams = {
  account: '',
  start: null,
  type: 'blog',
  limit: 50
};

export const getFollowing = async (params?: Partial<IGetFollowParams>): Promise<IFollow[]> => {
  try {
    const account = params?.account || DEFAULT_PARAMS_FOR_FOLLOW.account;
    const start = params?.start || '';
    const type = params?.type || DEFAULT_PARAMS_FOR_FOLLOW.type;
    const limit = params?.limit || DEFAULT_PARAMS_FOR_FOLLOW.limit;

    const following = await (await getChain()).api.condenser_api.get_following([
      account,
      start,
      type,
      limit
    ]);
    // A banned account is nobody's "following" entry, and the account itself has
    // no following list to browse.
    if (isBannedAuthor(account)) return [];
    return withoutBannedAuthors(following, (edge) => edge.following);
  } catch (error) {
    console.error('Error:', error);
    throw error;
  }
};

export const getAccountReputations = async (
  account_lower_bound: string,
  _limit: number
): Promise<IAccountReputations[]> => {
  const profile = await (await getChain()).api.bridge.get_profile({ account: account_lower_bound });
  if (!profile) {
    return [];
  }
  return [
    {
      account: profile.name,
      reputation: profile.reputation
    }
  ];
};
export const getDynamicGlobalProperties = async (): Promise<GetDynamicGlobalPropertiesResponse> => {
  // ★ RETRY + FAILOVER (2026-08-18). Every wallet, every profile and every HP
  // conversion waits on this one call, and it had neither — a single stalled
  // node turned into an 8s timeout and a hard failure for the whole page. Same
  // wrapper `getAccounts` already uses; see hive-network-error.ts.
  return withHiveRetry(
    async () => (await getChain()).api.database_api.get_dynamic_global_properties({}),
    'get_dynamic_global_properties'
  );
};

export const getFollowers = async (params?: Partial<IGetFollowParams>): Promise<IFollow[]> => {
  try {
    const account = params?.account || DEFAULT_PARAMS_FOR_FOLLOW.account;
    const start = params?.start || '';
    const type = params?.type || DEFAULT_PARAMS_FOR_FOLLOW.type;
    const limit = params?.limit || DEFAULT_PARAMS_FOR_FOLLOW.limit;

    const followers = await (await getChain()).api.condenser_api.get_followers([
      account,
      start,
      type,
      limit
    ]);
    if (isBannedAuthor(account)) return [];
    // He can still follow you on chain — nothing Lumen does can stop that. What
    // Lumen can do is never show him in your followers list.
    return withoutBannedAuthors(followers, (edge) => edge.follower);
  } catch (error) {
    console.error('Error:', error);
    throw error;
  }
};

/**
 * ★★★ NORMALISE THE SEARCH PATTERN BEFORE IT REACHES HIVE.
 *
 * `search_api.find_text` feeds the pattern straight into a PostgreSQL text
 * query, and characters that are meaningful to a `tsquery` blow it up. Measured
 * against api.hive.blog 2026-08-06:
 *
 *     pattern "O'Brien"  -> HTTP 502, XX000 "could not parse query string"
 *     pattern "don't"    -> HTTP 502, XX000 "could not parse query string"
 *     pattern "O Brien"  -> HTTP 200, results
 *
 * An apostrophe is not an edge case. It is in `don't`, `it's`, `O'Brien`,
 * `we're` — a huge share of what anyone types into a search box. Unhandled, the
 * page span a spinner for 10-15 s and then told the reader to go check whether
 * the node was running.
 *
 * So the metacharacters become SPACES rather than being deleted: `don't` as
 * `don t` matches the post that contains "don't", while `dont` would not.
 * Zero-width characters are removed outright — they are invisible, carry no
 * meaning, and produce a query the reader cannot see or correct.
 *
 * (`<` was reported alongside this and is NOT part of it: `hive<` searches fine.
 * `<script>` fails for an unrelated reason — it reduces to the very common term
 * "script" and hits the backend's own statement timeout, the same limit that
 * makes the "Newest" sort fail on broad words.)
 */
export function normalizeSearchPattern(pattern: string): string {
  return (pattern ?? '')
    // Invisible characters: zero-width space/non-joiner/joiner, BOM, soft hyphen.
    .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '')
    // tsquery operators and quoting. Space, not deletion — see above.
    .replace(/['"&|!()<>:*\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const getByText = async ({
  pattern,
  sort = 'relevance',
  author = '',
  limit = DATA_LIMIT,
  observer,
  start_author = '',
  start_permlink = ''
}: Parameters<Awaited<ReturnType<typeof getChain>>['api']['search-api']['find_text']>[0] // Temporary solution
): Promise<Entry[]> => {
  const safePattern = normalizeSearchPattern(pattern);
  // Nothing searchable left (e.g. the reader typed only punctuation). Asking
  // anyway returns a parse error the reader cannot act on.
  if (safePattern.length === 0) return [];
  // `?author=troll` — searching a banned account by name returns nothing rather
  // than his whole catalogue, which is the first thing anyone looking for him
  // will try.
  if (isBannedAuthor(author)) return [];
  const results = await (await getChain()).api['search-api'].find_text({
    pattern: safePattern,
    sort,
    author,
    limit,
    observer,
    start_author,
    start_permlink
  });
  return withoutBannedAuthors(results, (entry) => entry.author);
};

export const getActiveVotes = async (author: string, permlink: string): Promise<IVote[]> => {
  const BATCH_SIZE = 1000;
  const allVotes: IVoteListItem[] = [];
  let lastVoter = '';

  // Paginate through all votes for this post
  while (true) {
    const response = await getListVotesByCommentVoter([author, permlink, lastVoter], BATCH_SIZE);
    const postVotes = response.votes.filter((vote) => vote.author === author && vote.permlink === permlink);

    if (postVotes.length === 0) break;

    allVotes.push(...postVotes);

    // If we got fewer votes than requested, we've reached the end
    if (postVotes.length < BATCH_SIZE) break;

    // Set up for next page - start after the last voter
    lastVoter = postVotes[postVotes.length - 1].voter;
  }

  // ★ HE MUST NOT AFFECT ANY NUMBER LUMEN COMPUTES.
  //
  // This list is not only the voters popover. It is also the input to the
  // retention system's credited-giver breadth count (`app/api/streak/[user]`,
  // `creditedGivers`), which decides how far a real author can climb. Leaving a
  // banned account in here would let him inflate — or, by being counted as a
  // low-value "unknown" giver against a budget, dilute — other people's standing.
  // Dropping him at the source means every downstream tally is computed as if he
  // had never voted, with no arithmetic anywhere else needing to know he exists.
  const countedVotes = withoutBannedAuthors(allVotes, (vote) => vote.voter);

  // Transform to IVote format
  return countedVotes.map((vote) => ({
    voter: vote.voter,
    percent: vote.vote_percent,
    rshares: vote.rshares,
    time: vote.last_update,
    weight: typeof vote.weight === 'string' ? parseInt(vote.weight, 10) : vote.weight,
    reputation: 0 // Not available in database_api.list_votes
  }));
};
