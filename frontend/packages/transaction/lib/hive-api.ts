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
import { getLogger } from '@hive/ui/lib/logging';
import type { GetDynamicGlobalPropertiesResponse } from '@hiveio/wax';
import { getChain } from './chain';
import { withHiveRetry } from '@smart-signer/lib/hive-network-error';
import { withRetry } from './retry';
import { bannedAuthorList, hasBannedAuthors } from '@ui/config/lists/banned-authors';
import { stripInvisibleAndBidi } from '@ui/lib/text-safety';
import type { ApiAccount, IManabarData } from '@hiveio/wax';
import { DATA_LIMIT } from './bridge-api';
import { isBannedAuthor, withoutBannedAuthors } from '@ui/config/lists/banned-authors';

const logger = getLogger('app');

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

    // ★ A6 retry rollout (2026-08-18): the whole 3-call batch, retried together as
    // one idempotent read. The outer `try/catch` below silently swallows ANY
    // failure into `null` — before this, that meant a single fast transient blip
    // gave up on manabars immediately with no chance to recover. Single caller
    // (`getManabar`, used only by `/api/manabar`), so this cannot double anyone
    // else's retry.
    const [dgpo, {
      accounts: [account]
    }, {
      rc_accounts: [rcAccount]
    }] = await withRetry(
      () =>
        Promise.all([
          chain.api.database_api.get_dynamic_global_properties({}),
          chain.api.database_api.find_accounts({
            accounts: [accountName],
            delayed_votes_active: false
          }),
          chain.api.rc_api.find_rc_accounts({ accounts: [accountName] })
        ]),
      { label: `getManabars(${accountName})` }
    );

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

    // ★ CHAIN PROFILE TEXT IS UNTRUSTED (2026-08-23).
    //
    // A display name containing U+202E RIGHT-TO-LEFT OVERRIDE renders as somebody else's
    // name — the Trojan-Source username-spoofing shape, already closed on the LITE write
    // path. It CANNOT be closed on the chain write path: any Hive client can set these
    // bytes and Lumen never sees that transaction. So it is closed HERE, at the one place
    // every `account.profile` in the app is parsed.
    //
    // One edit instead of seven render sites (profile masthead, profile identity, the
    // author hover card, the `<meta>` description, page metadata, the witness description,
    // and the smart-signer profile helper) — and the eighth added next month is covered
    // without anyone remembering.
    //
    // Strips ONLY the invisible/direction-control class. Deliberately does not port the
    // write-path's truncation or C0/C1 handling: those are field-length policy, and
    // truncating on read would silently shorten a legitimate chain bio. U+200C and U+200D
    // are preserved, so Persian orthography and emoji ZWJ sequences survive intact.
    //
    // Safe against the block filter: `isBlockedEntry` matches on `entry.author`, the
    // ACCOUNT name, never on these display fields — so this cannot desynchronise a
    // comparison key.
    // ★ PRESERVE ABSENCE (2026-08-23). The three `*_description` fields are OPTIONAL and
    // are read back by `account-settings/form.tsx` to re-submit the profile unchanged.
    // Coercing an absent field to `''` would send an empty string on the next settings
    // save and WIPE a witness's description. Strip only what is actually there.
    const stripIfPresent = <T,>(value: T): T | string =>
      typeof value === 'string' ? stripInvisibleAndBidi(value) : value;

    profile = {
      ...profile,
      name: stripInvisibleAndBidi(profile.name),
      about: stripInvisibleAndBidi(profile.about),
      location: stripInvisibleAndBidi(profile.location),
      // Rendered by the witnesses table (`build-witness-rows.ts`, fed by the
      // UNAUTHENTICATED `/api/witnesses-page` for the top 100) and by the blacklist /
      // muted-list headers (`account-lists/list-item.tsx`, `list-variant.tsx`).
      // `stripMarkdown` does not touch U+202E, so these three were the gap this
      // chokepoint's own comment already claimed to have closed.
      witness_description: stripIfPresent(profile.witness_description),
      blacklist_description: stripIfPresent(profile.blacklist_description),
      muted_list_description: stripIfPresent(profile.muted_list_description)
    };

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
  // ★ A6 retry rollout (2026-08-18): idempotent read. Callers (`getAccountFull`,
  // `getFollowCount`) both already swallow a failure here into a fallback value
  // with no retry of their own, so a fast transient blip previously had zero
  // chance to recover before falling back.
  const profile = await withRetry(async () => (await getChain()).api.bridge.get_profile({ account: username }), {
    label: `get_profile(${username})`
  });
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
  // ★ A6 retry rollout (2026-08-18): idempotent read, single caller (`/api/reblogged-by`).
  const rebloggers = await withRetry(
    async () => (await getChain()).api.condenser_api.get_reblogged_by([author, permlink]),
    { label: `get_reblogged_by(${author}/${permlink})` }
  );
  // A banned account is not credited with amplifying anybody's post, and does not
  // appear in the "reblogged by" attribution list.
  return withoutBannedAuthors(rebloggers, (name) => name);
};

export const getFeedHistory = async (): Promise<IFeedHistory> => {
  // ★ A6 retry rollout (2026-08-18): idempotent read, single caller (`/api/feed-history`).
  return withRetry(async () => (await getChain()).api.database_api.get_feed_history(), {
    label: 'get_feed_history'
  });
};

/**
 * ★ DELIBERATELY NOT WRAPPED IN `withRetry` (A6 retry rollout, 2026-08-18).
 *
 * This is an idempotent read, but `getActiveVotes` below calls it in a
 * sequential pagination loop, and THAT is called from `streak/[user]/route.ts`
 * inside a `Promise.allSettled` fan-out where every call is individually raced
 * against `withTimeout(..., Math.min(CALL_TIMEOUT_MS, budgetLeft), ...)` — a
 * hand-rolled, shrinking wall-clock budget that route was specifically
 * hardened to enforce (see its own history: a slow node was previously
 * misread as "this account has no engagement"). `withTimeout` cannot cancel
 * the underlying call, so a retry loop added here would only prolong orphaned
 * background work in exactly the "node is slow, not down" case that route
 * already treats carefully, without the route ever seeing the benefit.
 *
 * `/api/comment-vote` and `/api/comment-vote/bulk` — the two callers that call
 * this directly, with no competing budget — get `withRetry` wired at their own
 * route level instead. `/api/active-votes` wraps its whole `getActiveVotes`
 * call the same way, without touching this shared primitive.
 */
// See https://developers.hive.io/apidefinitions/#database_api.list_votes
export const getListVotesByCommentVoter = async (
  start: [string, string, string] | null, // should be [author, permlink, voter]
  limit: number
): Promise<{ votes: IVoteListItem[] }> => {
  return (await getChain()).api.database_api.list_votes({ start, limit, order: 'by_comment_voter' });
};

export const getFindAccounts = async (username: string): Promise<{ accounts: ApiAccount[] }> => {
  // ★ A6 retry rollout (2026-08-18): idempotent read, single caller
  // (`/api/wallet/summary`, where it already runs inside a `Promise.all`
  // alongside `getAccount`/`getDynamicGlobalProperties` — both already covered by
  // `withHiveRetry`'s much larger 12s budget, so this smaller retry cannot widen
  // that parallel group's own worst case).
  return withRetry(
    async () =>
      (await getChain()).api.database_api.find_accounts({
        accounts: [username],
        delayed_votes_active: false
      }),
    { label: `find_accounts(${username})` }
  );
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

    // ★ A6 retry rollout (2026-08-18): idempotent read, single caller (`/api/following`,
    // already behind its own `cachedRead` memo).
    const following = await withRetry(
      async () => (await getChain()).api.condenser_api.get_following([account, start, type, limit]),
      { label: `get_following(${account})` }
    );
    // A banned account is nobody's "following" entry, and the account itself has
    // no following list to browse.
    if (isBannedAuthor(account)) return [];
    return withoutBannedAuthors(following, (edge) => edge.following);
  } catch (error) {
    // ★ ONE LINE, NOT A 40-LINE DUMP (2026-09-02, snappiness phase 1). This was
    // `console.error('Error:', error)`, which prints the whole WaxError with its
    // request and response objects: 11,976 such blocks and 175 MB of log in one
    // day, one per follower page the crawler asked for while the Hive node was
    // answering 429. The caller rethrows and logs the error itself; here the
    // label and the message are the useful part.
    logger.warn('%s failed: %s', 'get_following', error instanceof Error ? error.message : String(error));
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

    // ★ A6 retry rollout (2026-08-18): idempotent read, single caller (`/api/followers`).
    const followers = await withRetry(
      async () => (await getChain()).api.condenser_api.get_followers([account, start, type, limit]),
      { label: `get_followers(${account})` }
    );
    if (isBannedAuthor(account)) return [];
    // He can still follow you on chain — nothing Lumen does can stop that. What
    // Lumen can do is never show him in your followers list.
    return withoutBannedAuthors(followers, (edge) => edge.follower);
  } catch (error) {
    // ★ ONE LINE, NOT A 40-LINE DUMP (2026-09-02, snappiness phase 1). This was
    // `console.error('Error:', error)`, which prints the whole WaxError with its
    // request and response objects: 11,976 such blocks and 175 MB of log in one
    // day, one per follower page the crawler asked for while the Hive node was
    // answering 429. The caller rethrows and logs the error itself; here the
    // label and the message are the useful part.
    logger.warn('%s failed: %s', 'get_followers', error instanceof Error ? error.message : String(error));
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

/**
 * ★ DELIBERATELY NOT WRAPPED IN `withRetry` (A6 retry rollout, 2026-08-18).
 *
 * `/api/search`'s own catch block (2026-08-18, same day) already distinguishes
 * a Postgres `57014` statement-timeout ("canceling statement due to statement
 * timeout") from every other failure, specifically BECAUSE that one is
 * deterministic — sorting by Newest on a broad term aborts the same way on
 * every node that runs the search plugin, every time (measured 3/3) — and
 * retrying it cannot succeed, it only adds ~2x the latency (measured 12.4s
 * end-to-end for one attempt plus one retry) before the same failure.
 *
 * `retry.ts`'s own `isTransient` would misclassify exactly this case: its
 * `TRANSPORT_FAULT` regex matches the bare substring `timeout`, which is
 * present in both "statement timeout" (deterministic, Postgres) and a real
 * network timeout (transient) — it cannot tell them apart from the message
 * text alone. Wrapping this call would silently reintroduce the 12.4s
 * regression `/api/search` was just fixed to avoid. Flagging this as a
 * candidate to narrow `isTransient` itself (e.g. requiring `ETIMEDOUT`/
 * "request timed out" rather than bare "timeout", or explicitly excluding
 * "statement timeout"/"57014"/"canceling statement") rather than routing
 * around it here.
 */
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
