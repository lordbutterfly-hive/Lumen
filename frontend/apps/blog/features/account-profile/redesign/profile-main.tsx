'use client';

import { useParams, notFound } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { getAccountFull, getDynamicGlobalProperties } from '@transaction/lib/hive-api';
import { getChain } from '@transaction/lib/chain';
import { convertToHP } from '@ui/lib/utils';
import { convertStringToBig } from '@ui/lib/helpers';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { DEFAULT_OBSERVER, chainObserver } from '@/blog/lib/utils';
import { extractUsernameFromParam } from '@/blog/utils/validate-links';
import { useSSRObserver, useInitialPosts } from '@/blog/components/observer-provider';
import { useFollowingInfiniteQuery } from '@/blog/features/account-lists/hooks/use-following-infinitequery';
import NoDataError from '@/blog/components/no-data-error';
import { ProfileLeagueCard } from '@/blog/features/retention/components/profile-league-card';
import ProfileMainSkeleton from './profile-main-skeleton';
import ProfileCover from './profile-cover';
import ProfileIdentity from './profile-identity';
import ProfileActions from './profile-actions';
import ProfileStatsBar from './profile-stats-bar';
import ProfileTabs from './profile-tabs';
import { getCoverImageUrl } from './lib/get-cover-image-url';

/**
 * Redesigned profile page (design-handoff-v2, Profile.dc.html), mounted at
 * the (user-profile) route group's root — `/@username`. Reuses the exact
 * data-fetch shape `ProfileLayout` (features/layouts/user-profile) already
 * established: same `getAccountFull`/`getDynamicGlobalProperties`/`getChain`
 * calls, same `['profileData', username]` / `['dynamicGlobalData']` query
 * keys the route's layout.tsx server-prefetches, so this component inherits
 * that SSR hydration for free instead of re-fetching on first paint.
 */
export default function ProfileMain() {
  const params = useParams<{ param: string }>();
  const username = extractUsernameFromParam(params?.param ?? '') ?? '';
  const { user, isHydrated } = useUserClient();
  const ssrObserver = useSSRObserver();
  const initialPosts = useInitialPosts();
  const observer = isHydrated ? (chainObserver(user)) : ssrObserver;

  const {
    data: profileData,
    isError: isProfileError,
    isLoading: isProfilePending
  } = useQuery({
    queryKey: ['profileData', username],
    queryFn: () => getAccountFull(username),
    enabled: Boolean(username)
  });

  const {
    data: dynamicGlobalData,
    isError: isDynamicGlobalError,
    isLoading: isDynamicGlobalPending
  } = useQuery({
    queryKey: ['dynamicGlobalData'],
    queryFn: () => getDynamicGlobalProperties()
  });

  const {
    data: hiveChain,
    isError: isChainError,
    isLoading: isChainPending
  } = useQuery({
    queryKey: ['hiveChain'],
    queryFn: () => getChain(),
    staleTime: Infinity
  });

  // Viewer's own following list — drives both ProfileActions' isFollow state
  // and (for an own-profile view) the live following-count stat below.
  const following = useFollowingInfiniteQuery(user.username, 1000, 'blog', ['blog']);

  if (isProfileError || isDynamicGlobalError || isChainError) {
    return <NoDataError />;
  }

  if (isProfilePending || isDynamicGlobalPending || isChainPending || !hiveChain) {
    return <ProfileMainSkeleton />;
  }

  if (!profileData) {
    return notFound();
  }

  if (
    !dynamicGlobalData ||
    !profileData.delegated_vesting_shares ||
    !profileData.received_vesting_shares ||
    !profileData.vesting_shares
  ) {
    return <NoDataError />;
  }

  const delegatedHive = convertToHP(
    convertStringToBig(profileData.delegated_vesting_shares).minus(
      convertStringToBig(profileData.received_vesting_shares)
    ),
    hiveChain,
    dynamicGlobalData.total_vesting_shares,
    dynamicGlobalData.total_vesting_fund_hive
  );
  const vestingHive = convertToHP(
    convertStringToBig(profileData.vesting_shares),
    hiveChain,
    dynamicGlobalData.total_vesting_shares,
    dynamicGlobalData.total_vesting_fund_hive
  );
  // ★ HP HEADLINE = OWN STAKE, matching how Hive's own wallet presents it
  // (2026-08-06, owner ruling). Hive shows the account's OWN staked HIVE as the
  // prominent figure and the delegation-adjusted total underneath as "Tot:":
  //
  //     74,842.337        <- own vesting_shares converted   (headline)
  //     Tot: 69,665.865   <- own - delegated out + received  (secondary)
  //
  // This page previously showed ONLY the second number, unlabelled, so it read
  // as a wrong balance next to every other Hive frontend. Both are correct —
  // they answer different questions (what you own vs what you can vote with) —
  // and the fix is to show them the way a Hive user already expects.
  const hp = vestingHive;
  const hpEffective = vestingHive.minus(delegatedHive);

  const isOwnProfile = user.isLoggedIn && username === user.username;
  const followingCount =
    isOwnProfile && following.data?.pages
      ? following.data.pages.reduce((sum, page) => sum + page.length, 0)
      : (profileData.follow_stats?.following_count ?? 0);

  return (
    <div data-testid="profile-redesign-main">
      <ProfileCover username={username} coverImageUrl={getCoverImageUrl(profileData.profile)} />

      <div className="mt-[58px] flex flex-wrap items-start justify-between gap-5 pl-1.5">
        <ProfileIdentity
          username={username}
          chainAccount={!profileData._temporary}
          displayName={profileData.profile?.name || profileData.name}
          profile={profileData.profile}
          created={profileData.created}
          lastVoteTime={profileData.last_vote_time}
          lastPost={profileData.last_post}
        />
        {/* `_temporary` is how a Lumen lite account's stand-in profile is marked: no
            Hive account exists behind it, so a follow of this person can only live on
            Lumen. It is a hint, not a decision — the server confirms it. */}
        <ProfileActions
          username={username}
          following={following}
          liteTarget={Boolean(profileData._temporary)}
        />
      </div>

      <ProfileStatsBar
        username={username}
        followerCount={profileData.follow_stats?.follower_count ?? 0}
        postCount={profileData.post_count ?? 0}
        followingCount={followingCount}
        hp={hp.toFixed(0)}
        hpEffective={hpEffective.toFixed(0)}
      />

      <ProfileLeagueCard username={username} className="mt-5" chainAccount={!profileData._temporary} />

      <div className="mt-7">
        <ProfileTabs
          username={username}
          observer={observer}
          postsCount={profileData.post_count}
          initialPosts={initialPosts}
          lite={Boolean(profileData._temporary)}
        />
      </div>
    </div>
  );
}
