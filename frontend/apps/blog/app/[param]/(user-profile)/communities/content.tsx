'use client';

import SocialActivities from '@/blog/features/account-social/social-activities';
import SubscriptionList from '@/blog/features/account-social/subscription-list';
import { useTranslation } from '@/blog/i18n/client';
import { useQuery } from '@tanstack/react-query';
import { fetchSubscriptions } from '@/blog/lib/chain-fetch';
import { getHivebuzzBadges, getPeakdBadges, isThirdPartyApiEnabled } from '@transaction/lib/custom-api';
import { getUserAvatarUrl } from '@ui/lib/avatar-utils';
import { Link } from '@hive/ui';

const CommunityContent = ({ username }: { username: string }) => {
  const { t } = useTranslation('common_blog');
  const thirdPartyEnabled = isThirdPartyApiEnabled();

  // ★ THROUGH OUR SERVER, NOT THE CHAIN CLIENT (2026-08-12). Unconditional
  // (no `enabled` gate). See `apps/blog/app/api/subscriptions/route.ts`.
  // ★★★ A FAILED READ IS NOT "NO SUBSCRIPTIONS" (2026-08-28, false-text audit,
  // Cluster A sweep — the twin of the delegations panel, found by grepping for
  // the same shape rather than by being reported).
  //
  // This destructured `data` alone, so a failed `/api/subscriptions` left it
  // undefined and the empty branch below greeted the reader with "Welcome! You
  // don't have any subscriptions yet." on a profile that may well be subscribed
  // to a dozen communities. Error first, then loading, then empty — the ordering
  // `features/account-settings/blocked-list.tsx` and
  // `features/wallet/components/account-history-list.tsx` already use.
  const { data, isLoading, isError } = useQuery({
    queryKey: ['listAllSubscription', username],
    queryFn: () => fetchSubscriptions(username)
  });

  const { data: hivebuzz } = useQuery({
    queryKey: ['hivebuzz', username],
    queryFn: () => getHivebuzzBadges(username),
    enabled: thirdPartyEnabled
  });

  const { data: peakd } = useQuery({
    queryKey: ['peakd', username],
    queryFn: () => getPeakdBadges(username),
    enabled: thirdPartyEnabled,
    select: (data) =>
      data.map((e: { id: string; name: string; title: string }) => ({
        id: e.title,
        url: getUserAvatarUrl(e.name, 'medium'),
        title: e.title
      }))
  });

  return (
    <div className="flex flex-col py-8">
      <h2 className="text-xl font-semibold" data-testid="community-subscriptions-label">
        {t('user_profile.social_tab.community_subscriptions_title')}
      </h2>
      <p data-testid="community-subscriptions-description">
        {t('user_profile.social_tab.the_author_has_subscribed_to_the_following')}
      </p>
      {isError ? (
        <div
          key="unavailable"
          className="border-card-empty-border my-12 border-2 border-solid bg-card-noContent px-4 py-6 text-sm text-destructive"
          data-testid="community-subscriptions-error"
        >
          {t('user_profile.social_tab.subscriptions_unavailable')}
        </div>
      ) : isLoading ? (
        <div
          key="loading"
          className="border-card-empty-border my-12 border-2 border-solid bg-card-noContent px-4 py-6 text-sm"
          data-testid="community-subscriptions-loading"
        >
          {t('user_profile.social_tab.subscriptions_loading')}
        </div>
      ) : data && data.length > 0 ? (
        <SubscriptionList data={data} />
      ) : (
        <div
          key="empty"
          className="border-card-empty-border my-12 border-2 border-solid bg-card-noContent  px-4 py-6 text-sm"
          data-testid="user-does-not-have-any-subscriptions-yet"
        >
          {t('user_profile.social_tab.you_dont_have_any_subscriptions')}
        </div>
      )}
      <h2 className="text-xl font-semibold" data-testid="badges-achievements-label">
        {t('user_profile.social_tab.badges_and_achievements_title')}
      </h2>
      {thirdPartyEnabled ? (
        <>
          <p data-testid="badges-achievements-description">
            {t('user_profile.social_tab.these_are_badges_received_by_the_author')}
            <Link href="https://peakd.com/" className="text-destructive hover:underline" target="_blank">
              Peakd
            </Link>
            {` & `}
            <Link href="https://hivebuzz.me/" className="text-destructive hover:underline" target="_blank">
              Hivebuzz
            </Link>
            .
          </p>
          <SocialActivities data={hivebuzz ?? []} peakd={peakd ?? []} username={username} />
        </>
      ) : (
        <p data-testid="badges-achievements-description">
          {t('user_profile.social_tab.view_badges_on')}{' '}
          <Link
            href={`https://peakd.com/@${username}/badges`}
            className="text-destructive hover:underline"
            target="_blank"
          >
            Peakd
          </Link>
          {` & `}
          <Link
            href={`https://hivebuzz.me/@${username}`}
            className="text-destructive hover:underline"
            target="_blank"
          >
            Hivebuzz
          </Link>
          .
        </p>
      )}
    </div>
  );
};
export default CommunityContent;
