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
import ProfileTokenCard from '@/blog/features/creator-tokens/ui/profile-token-card';
import PageMasthead from '@/blog/features/layouts/page-masthead';
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

      {/* ★ P-1: THE SHELL, AND THE SIX PIXELS.
          The identity block was bare text on the page background — the same "no
          shell at all" shape /witnesses carried before it was fixed — and it sat
          in a `pl-1.5` container, so the h1 landed at x=294 while the cover
          directly above it started at x=288. Six pixels is enough to see and
          there was no reason for it. The padding is gone and the block is in the
          shared masthead, which owns the shell and the grid position for every
          page. No `mark`: a profile has no assigned glyph and R5 forbids
          inventing one. */}
      <div className="mt-[58px]">
        {/* The h1 is the person's NAME and nothing else. The rank chip used to sit
            inside the heading; through the masthead's `title` slot that would have
            made the page's h1 read "hbd-temp Unranked·rank 0 of 9" to a screen
            reader and to a search engine. It moved one line down, into the meta
            row beside the reputation pill, which is where the other badge about
            this person already lives. */}
        <PageMasthead title={profileData.profile?.name || profileData.name}>
          {/* Identity and Follow go into the masthead's meta slot as ONE row
              rather than through its `actions` prop: that slot is vertically
              centred, and this meta block is tall (handle, reputation, bio,
              tenure), so the Follow button would float to the middle of it. The
              row below is the exact `items-start justify-between gap-5` pairing
              the page already had; only the shell around it is new. */}
          <div className="flex w-full flex-wrap items-start justify-between gap-5">
            <ProfileIdentity
              username={username}
              chainAccount={!profileData._temporary}
              profile={profileData.profile}
              created={profileData.created}
              lastVoteTime={profileData.last_vote_time}
              lastPost={profileData.last_post}
              // Already on this object: `getAccountFull` attaches it from
              // `bridge.get_profile` (packages/transaction/lib/hive-api.ts). Zero extra
              // requests for the badge.
              reputation={profileData.reputation}
            />
            {/* `_temporary` is how a Lumen lite account's stand-in profile is marked:
                no Hive account exists behind it, so a follow of this person can only
                live on Lumen. It is a hint, not a decision — the server confirms it. */}
            <ProfileActions
              username={username}
              following={following}
              liteTarget={Boolean(profileData._temporary)}
            />
          </div>
        </PageMasthead>
      </div>

      <ProfileStatsBar
        username={username}
        followerCount={profileData.follow_stats?.follower_count ?? 0}
        postCount={profileData.post_count ?? 0}
        followingCount={followingCount}
        // ★ W-11: three decimals, the same precision the wallet prints, because
        // the two pages showed the same account's HP as "74,868" here and
        // "74,867.553" there and left the reader to work out whether that was
        // two numbers or one. ProfileStatsBar still does the comma grouping, so
        // what goes in is an ungrouped fixed-point string, as it always was.
        hp={hp.toFixed(3)}
        hpEffective={hpEffective.toFixed(3)}
      />

      {/* Creator-token surface (design brief §3, creator-token-prominence pass):
          directly under the stats row and above the Posts/Comments tabs — and
          above the league/rank card below, which is the closest real analogue
          this app has to the brief's "Spark rank card" (the mockup predates
          the retention rework and has no such card at all). Renders nothing of
          its own when there is nothing real to show — see the component's doc. */}
      <ProfileTokenCard username={username} isOwnProfile={isOwnProfile} />

      <ProfileLeagueCard username={username} className="mt-5" chainAccount={!profileData._temporary} />

      <div className="mt-7">
        <ProfileTabs
          username={username}
          observer={observer}
          initialPosts={initialPosts}
          lite={Boolean(profileData._temporary)}
        />
      </div>
    </div>
  );
}
