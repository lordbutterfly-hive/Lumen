'use client';

import { useParams, notFound } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { fetchAccount, fetchDynamicGlobalProperties, fetchVestsToHp } from '@/blog/lib/chain-fetch';
import { convertStringToBig } from '@ui/lib/helpers';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import { DEFAULT_OBSERVER, chainObserver } from '@/blog/lib/utils';
import { extractUsernameFromParam } from '@/blog/utils/validate-links';
import { useSSRObserver, useInitialPosts } from '@/blog/components/observer-provider';
import { useFollowingInfiniteQuery } from '@/blog/features/account-lists/hooks/use-following-infinitequery';
import { useModerationStatus } from '@/blog/features/mute-follow/hooks/use-moderation-status';
import NoDataError from '@/blog/components/no-data-error';
import ProfileTokenCard from '@/blog/features/creator-tokens/ui/profile-token-card';
import PageMasthead from '@/blog/features/layouts/page-masthead';
import { cn } from '@ui/lib/utils';
import { LumenLoader } from '@hive/ui';
import { useTranslation } from '@/blog/i18n/client';
import ProfileCover from './profile-cover';
import ProfileIdentity from './profile-identity';
import ProfileActions from './profile-actions';
import ProfileTabs from './profile-tabs';
import { getCoverImageUrl } from './lib/get-cover-image-url';

/**
 * Redesigned profile page (design-handoff-v2, Profile.dc.html), mounted at
 * the (user-profile) route group's root — `/@username`. Reuses the exact
 * data-fetch shape `ProfileLayout` (features/layouts/user-profile) already
 * established: same `['profileData', username]` / `['dynamicGlobalData']`
 * query keys the route's layout.tsx server-prefetches, so this component
 * inherits that SSR hydration for free instead of re-fetching on first
 * paint.
 *
 * ★ THROUGH OUR SERVER, NOT THE CHAIN CLIENT (2026-08-12). The three queries
 * below used to call `getAccountFull`/`getDynamicGlobalProperties`/`getChain`
 * directly, here in the browser — the last one via its own unconditional
 * `useQuery({queryFn: () => getChain()})`, used only to reach
 * `chain.vestsToHp()` for the HP figures further down. `getChain()`
 * INSTANTIATES `@hiveio/wax` at runtime and downloads `wax.common.wasm`
 * (2.34 MB) — none of that was gated on being signed in, so this ran for
 * every visitor to `/@username`, the second-highest-traffic route in the
 * app. See `apps/blog/app/api/account/route.ts`,
 * `.../api/dynamic-global-properties/route.ts` and
 * `.../api/vests-to-hp/route.ts`.
 */
export default function ProfileMain() {
  const { t } = useTranslation('common_blog');
  const params = useParams<{ param: string }>();
  const username = extractUsernameFromParam(params?.param ?? '') ?? '';
  const { user, isHydrated } = useUserClient();
  /**
   * ★★★ SAME RACE AS EVERY OTHER OWNERSHIP GATE (2026-08-12, G3). `isOwnProfile`
   * below used to read straight off `user.isLoggedIn`/`user.username`, which
   * cannot answer during SSR and reports signed-out until `/api/users/me`
   * returns. A signed-in reader hard-loading their own profile would briefly
   * read as a visitor: `followingCount` fell back to the profile's on-chain
   * `follow_stats.following_count` instead of the live query result, and the
   * viewer's own following list (`following` below) was fetched under an
   * empty username until the client caught up. `identity`
   * (`features/layouts/server-session.tsx`, the same fix `ProfileActions` /
   * `MutedList` / `ListVariant` already carry) is seeded from the session
   * cookie the server already read, so both are correct from the first
   * render. `user`/`isHydrated` stay in play below only for `chainObserver`,
   * which needs `account_tier` — a field that only exists on the real client
   * object, never on `identity`.
   */
  const identity = useSessionIdentity();
  const ssrObserver = useSSRObserver();
  const initialPosts = useInitialPosts();
  const observer = isHydrated ? (chainObserver(user)) : ssrObserver;

  const {
    data: profileData,
    isError: isProfileError,
    isLoading: isProfilePending
  } = useQuery({
    queryKey: ['profileData', username],
    queryFn: () => fetchAccount(username),
    enabled: Boolean(username)
  });

  const {
    data: dynamicGlobalData,
    isError: isDynamicGlobalError,
    isLoading: isDynamicGlobalPending
  } = useQuery({
    queryKey: ['dynamicGlobalData'],
    queryFn: () => fetchDynamicGlobalProperties()
  });

  // Replaces the old `hiveChain` query (`getChain()`, unconditional, no
  // `enabled` guard) — the chain instance itself was never displayed, it only
  // fed the two `convertToHP` calls below. Both HP figures are fetched here
  // together, once `profileData`/`dynamicGlobalData` are in, via
  // `fetchVestsToHp` (see its doc comment for why the computation itself
  // stays server-side rather than being reimplemented in plain JS).
  const canComputeHp = Boolean(
    profileData?.delegated_vesting_shares && profileData?.received_vesting_shares && profileData?.vesting_shares
  );
  const { data: hpFigures, isError: isChainError } = useQuery({
    queryKey: ['profileHpFigures', username, dynamicGlobalData?.total_vesting_shares],
    queryFn: async () => {
      const totalVestingShares = dynamicGlobalData!.total_vesting_shares;
      const totalVestingFundHive = dynamicGlobalData!.total_vesting_fund_hive;
      const [delegatedHive, vestingHive] = await Promise.all([
        fetchVestsToHp(
          convertStringToBig(profileData!.delegated_vesting_shares!).minus(
            convertStringToBig(profileData!.received_vesting_shares!)
          ),
          totalVestingShares,
          totalVestingFundHive
        ),
        fetchVestsToHp(convertStringToBig(profileData!.vesting_shares!), totalVestingShares, totalVestingFundHive)
      ]);
      return { delegatedHive, vestingHive };
    },
    enabled: Boolean(profileData) && Boolean(dynamicGlobalData) && canComputeHp
  });

  // Viewer's own following list — drives both ProfileActions' isFollow state
  // and (for an own-profile view) the live following-count stat below.
  // `identity.username`, not `user.username` — see the race note above.
  const following = useFollowingInfiniteQuery(identity.username, 1000, 'blog', ['blog']);

  // ★ E1 (BUILDMAP-FUCKERY-V2). Same hook `ProfileActions` and the post/comment
  // overflow menus use, called again here rather than lifted and passed down: it is
  // a read-only cache-backed query (react-query dedupes the network call across all
  // three call sites), and lifting it would mean threading moderation state through
  // a component this file otherwise has no reason to touch.
  //
  // ★ THE STANDALONE BANNER IS GONE (2026-08-12, Block consolidation cleanup).
  // This file used to also mount `ProfileModerationBanner` here, which
  // re-derived this same `isModerated` flag to print "You have muted/
  // blacklisted @user" with its own Unmute/Unblacklist buttons and "View
  // list" links — a second, page-level status readout on top of the badge
  // `ProfileActions` already shows in the CTA slot (`moderated_badge_*`),
  // and a second live control on top of Settings' Blocked Accounts / Muted
  // Users cards and the `/lists/*` pages, which is where mute and blacklist
  // entries are actually managed post-consolidation (see
  // `account-settings/blocked-list.tsx`, `muted-list.tsx`,
  // `moderation-lists.tsx` — all three are reachable from Settings and none
  // of their routes/actions were removed, so nothing a viewer set before
  // this is stranded). Relabelling the banner's actions "Unblock" to match
  // the owner's "one control called Block" ruling would have been actively
  // wrong, not just redundant: this state is on-chain mute/blacklist, not a
  // Lumen Block (`lib/lite/social/block-service.ts`) — the two are
  // unrelated records — and a banner reading "Unblock" here without
  // touching an actual Lumen block is exactly the "I blocked them and
  // they're still there" confusion that file's own doc comment warns
  // against. `moderation` stays wired into this component only for the two
  // dimming cues below (`ProfileCover`'s wrapper, `ProfileIdentity`'s
  // `moderated` prop) — visual cues, not controls.
  //
  // ★★ MUST STAY ABOVE EVERY EARLY RETURN BELOW (bug caught live, 2026-08-11).
  // `useModerationStatus` calls several hooks of its own. Placed after the
  // pending/error/notFound returns, the FIRST render (still loading) skips it
  // entirely and a LATER render (data arrived) reaches it — "Rendered more hooks
  // than during the previous render", a hard React crash, not a slow page. It
  // looked like a hang because the error boundary swallowed it. `profileData` is
  // not needed for the call itself — `Boolean(profileData?._temporary)` is safe
  // before the `!profileData` check below ever runs.
  const moderation = useModerationStatus(username, Boolean(profileData?._temporary));

  if (isProfileError || isDynamicGlobalError) {
    return <NoDataError />;
  }

  if (isProfilePending || isDynamicGlobalPending) {
    return <LumenLoader size="lg" className="min-h-[70vh]" label={t('global.loading_profile')} />;
  }

  if (!profileData) {
    return notFound();
  }

  if (!dynamicGlobalData) {
    return <NoDataError />;
  }

  // ★★★ HP NO LONGER GATES THE PAGE (2026-08-28, owner: "profile always loads
  // a bit too slow... it is janky"). `hpFigures` is a THIRD, independent round
  // trip (`/api/vests-to-hp`, client-only — never part of the layout's server
  // prefetch/hydration) layered on top of `profileData`/`dynamicGlobalData`,
  // which are already on the page from SSR hydration by the time this
  // component mounts. This used to gate the ENTIRE page — cover, identity,
  // bio, tabs, and the Posts tab's own fetch inside `ProfileTabs` below — behind
  // a full-viewport `LumenLoader`, invisible until this one extra fetch
  // resolved, then all popping in at once. Measured live: the rest of the page
  // is ready by `domContentLoaded` (~700ms warm), but `hpFigures` only STARTS
  // fetching once hydration finishes and doesn't land for another ~100-200ms —
  // during which nothing rendered, including the Posts tab's own
  // `account-posts`/`streak`/creator-token fetches, which mount inside
  // `ProfileTabs` and therefore waited on HP too, for a number two lines of
  // the page use.
  //
  // HP is genuinely optional: `ProfileIdentity` already renders its stats line
  // without an HP entry when `hp` is undefined (`profile-identity.tsx`, the
  // `{hp ? (...) : null}` branch) — that fallback existed and was simply never
  // reached because this component refused to render anything until HP was
  // ready. Wiring it through as optional instead of gating on it means the
  // rest of the page appears the moment the data it actually needs is ready,
  // and the HP figure fills in a beat later as one more entry on an existing
  // line — not a full-page reflow. Same trade for `isChainError`: a failed HP
  // read is no longer a reason to blank the whole profile, just to omit HP.
  //
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
  const hp = canComputeHp && !isChainError && hpFigures ? hpFigures.vestingHive : undefined;
  const hpEffective =
    canComputeHp && !isChainError && hpFigures ? hpFigures.vestingHive.minus(hpFigures.delegatedHive) : undefined;

  const isOwnProfile = identity.isLoggedIn && username === identity.username;
  const followingCount =
    isOwnProfile && following.data?.pages
      ? following.data.pages.reduce((sum, page) => sum + page.length, 0)
      : (profileData.follow_stats?.following_count ?? 0);

  return (
    <div data-testid="profile-redesign-main">
      {/* ★ E1 — "no dimming" was the specific, named gap. A muted/blacklisted
          account's cover and identity block now visibly read as moderated instead
          of rendering pixel-identical to any other profile. The standalone
          moderation banner that used to sit above this and spell the reason out
          in words is gone (2026-08-12, Block consolidation cleanup — see the
          `moderation` comment above); the CTA-slot badge in `ProfileActions`
          ("Muted" / "Blacklisted" / "Muted & Blacklisted") is now this page's
          only textual moderation readout, so this dimming stays what it always
          was underneath the banner: a purely visual cue, not the explanation. */}
      <div className={cn(moderation.isModerated && 'opacity-60 grayscale')} data-testid="profile-moderated-visuals">
        <ProfileCover username={username} coverImageUrl={getCoverImageUrl(profileData.profile)} />
      </div>

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
              moderated={moderation.isModerated}
              // ★ DEFECT FIX (2026-08-17): feeds the empty-bio "add a bio" prompt
              // in `profile-identity.tsx` — `isOwnProfile` was already computed
              // here for the stats-line following count below, just not passed
              // down to this component.
              isOwnProfile={isOwnProfile}
              // ★ The stats line these feed used to be a separate 112px card
              // (`ProfileStatsBar`, deleted 2026-08-13). `follow_stats` is passed
              // WITHOUT a `?? 0` fallback on purpose: absent means absent, and the
              // line renders an em dash rather than an invented zero.
              followerCount={profileData.follow_stats?.follower_count}
              postCount={profileData.post_count}
              followingCount={followingCount}
              hp={hp?.toFixed(3)}
              hpEffective={hpEffective?.toFixed(3)}
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


      {/* Creator-token surface (design brief §3, creator-token-prominence pass):
          directly under the stats row and above the Posts/Comments tabs — and
          above the league/rank card below, which is the closest real analogue
          this app has to the brief's "Spark rank card" (the mockup predates
          the retention rework and has no such card at all). Renders nothing of
          its own when there is nothing real to show — see the component's doc. */}
      <ProfileTokenCard username={username} isOwnProfile={isOwnProfile} />

      {/* ★ THE RANK CARD IS GONE FROM THE PROFILE (2026-08-19, owner):
          "get rid of that card completely. its enough what we have, it doesnt
          have to take up so much room. we already have the left navbar with same
          text and its not needed there."

          It rendered the emblem, "Ember / rank 2 of 9", the rung sentence, a
          progress bar, "N more active days to Candle" and the whole stats list —
          roughly half a screen on the owner's 1080p capture, directly above the
          Posts/Comments tabs. The rank and its position are already on the page
          twice over: `ProfileLeagueChip` in the identity block and the rank line
          in the left rail.

          ★ ONLY THE MOUNT IS REMOVED. `ProfileLeagueCard` is left in the tree
          because four comments elsewhere (use-post-form-actions, use-post-mutation,
          use-viewer-retention, lite/retention/wire) cite it when explaining which
          query keys they invalidate, and `RetentionStats` — the block it rendered —
          is still live inside `LeagueShowcase` and `RanksLadder`. Deleting the file
          would strand those references without removing anything from the screen. */}

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
