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
  const result = await (await getChain()).api.database_api.find_accounts({
    accounts: usernames,
    delayed_votes_active: false
  });

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
  return {
    follow_stats: {
      account: username,
      follower_count: profile.stats.followers,
      following_count: profile.stats.following
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
  return (await getChain()).api.database_api.get_dynamic_global_properties({});
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
