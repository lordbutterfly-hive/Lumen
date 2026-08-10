import { FullAccount } from '@hive/common-hiveio-packages/wax';
import * as users from '../repositories/user-repository';
import * as posts from '../repositories/post-repository';
import * as follows from '../repositories/follow-repository';

/**
 * A profile-shaped view of a lite account.
 *
 * WHY: the profile route resolves `/@name` by asking Hive for that account and calls
 * `notFound()` when it doesn't exist. A lite user has no Hive account until they
 * upgrade, so **every lite user's own profile 404'd** — they could not see themselves,
 * which also blocked every affordance that hangs off a profile page (Follow being the
 * obvious one).
 *
 * So we hand the page an account object built from what we actually know. Everything
 * chain-shaped is ZEROED, not faked: no balances, no vesting, no reputation, no
 * governance. A lite account genuinely holds nothing on chain — presenting invented
 * numbers would be worse than presenting none, and `post_count` is the one figure we
 * can state truthfully because we store the posts ourselves.
 *
 * `_temporary` marks it as not-a-real-chain-account, which is the existing convention
 * in this codebase for exactly this kind of stand-in.
 */

const ZERO_HIVE = { amount: '0', precision: 3, nai: '@@000000021' };
const ZERO_HBD = { amount: '0', precision: 3, nai: '@@000000013' };
const ZERO_VESTS = { amount: '0', precision: 6, nai: '@@000000037' };
const NO_AUTHORITY = { weight_threshold: 1, account_auths: [], key_auths: [] };
const EPOCH = '1970-01-01T00:00:00';
const ZERO_MANABAR = { current_mana: '0', last_update_time: 0 };

export async function liteAccountAsProfile(displayName: string): Promise<FullAccount | null> {
  const user = await users.findUserByDisplayName(displayName.trim().toLowerCase());
  if (!user) return null;
  // An upgraded user has a REAL Hive account; the normal chain lookup owns that case
  // and will have succeeded before we were ever called.
  if (user.accountTier === 'full' || user.hiveAccountName) return null;

  // ROOT posts only — this becomes `post_count`, which the profile prints under
  // the word "Posts" and the Posts tab repeats in its chip, above a list that has
  // always been root-only. See countRootPostsByUser.
  const postCount = await posts.countRootPostsByUser(user.userId);
  const created = user.createdAt.toISOString().slice(0, 19);
  // Real numbers, from our own graph. A lite account's follows cannot be on chain, so
  // these are the only true counts that exist for it — the zeros this used to render
  // were not caution, they were wrong.
  const actor = { userId: user.userId };
  const [followerCount, followingCount] = await Promise.all([
    follows.countFollowers(actor),
    follows.countFollowing(actor)
  ]);
  // What the user set on /@name/settings. Stored in Postgres rather than in
  // `posting_json_metadata` on chain, because there is no chain account to write to —
  // but shaped identically, so every renderer downstream is unaware of the difference.
  const profile = {
    name: user.profile?.name || user.displayName,
    about: user.profile?.about ?? '',
    location: user.profile?.location ?? '',
    website: user.profile?.website ?? '',
    profile_image: user.avatarUrl || user.profile?.profile_image || '',
    cover_image: user.profile?.cover_image ?? ''
  };

  return {
    name: user.displayName,
    owner: NO_AUTHORITY,
    active: NO_AUTHORITY,
    posting: NO_AUTHORITY,
    memo_key: '',
    post_count: postCount,
    created,
    json_metadata: '',
    posting_json_metadata: JSON.stringify({ profile: { ...profile, version: 2 } }),
    last_vote_time: EPOCH,
    last_post: EPOCH,
    reward_hbd_balance: ZERO_HBD,
    reward_vesting_hive: ZERO_HIVE,
    reward_hive_balance: ZERO_HIVE,
    reward_vesting_balance: ZERO_VESTS,
    governance_vote_expiration_ts: EPOCH,
    balance: ZERO_HIVE,
    vesting_shares: ZERO_VESTS,
    hbd_balance: ZERO_HBD,
    savings_balance: ZERO_HIVE,
    savings_hbd_balance: ZERO_HBD,
    savings_hbd_seconds: '0',
    savings_hbd_last_interest_payment: EPOCH,
    savings_hbd_seconds_last_update: EPOCH,
    next_vesting_withdrawal: '1969-12-31T23:59:59',
    delegated_vesting_shares: ZERO_VESTS,
    received_vesting_shares: ZERO_VESTS,
    vesting_withdraw_rate: ZERO_VESTS,
    to_withdraw: 0,
    withdrawn: 0,
    proxy: '',
    proxied_vsf_votes: ['0', '0', '0', '0'],
    voting_manabar: ZERO_MANABAR,
    downvote_manabar: ZERO_MANABAR,
    witness_votes: [],
    // Reputation is a chain-derived score. A lite account has none; 25 is Hive's
    // own "new account" floor, so it renders as new rather than as suspicious.
    reputation: 25,
    profile,
    follow_stats: {
      account: user.displayName,
      following_count: followingCount,
      follower_count: followerCount
    },
    __loaded: true,
    _temporary: true
  } as FullAccount;
}
