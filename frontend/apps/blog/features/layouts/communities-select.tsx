'use client';

import * as React from 'react';

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@ui/components/select';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from '@/blog/i18n/client';
import { withBasePath } from '@ui/lib/path-utils';
import { fetchCommunities, fetchSubscriptions } from '@/blog/lib/chain-fetch';
import { useRouter } from 'next/navigation';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import { DEFAULT_OBSERVER, chainObserver } from '@/blog/lib/utils';
import { StaleTime } from '@/blog/lib/react-query';
import { useSSRObserver, useInitialCommunities, useInitialSubscriptions } from '@/blog/components/observer-provider';

/**
 * ★ THROUGH OUR SERVER, NOT THE CHAIN CLIENT (2026-08-12). This dropdown
 * mounts on every main/community feed page (see the identity-race comment
 * below), and its `communitiesList` query ran UNCONDITIONALLY — `getChain()`
 * downloaded `wax.common.wasm` for every visitor, signed in or not, on
 * nearly every page shell. See `apps/blog/app/api/communities/route.ts`.
 */
export function CommunitiesSelect({ title }: { title: string }) {
  const { user, isHydrated } = useUserClient();
  /**
   * ★ SAME DEFECT AS /witnesses (2026-08-11, class sweep). This dropdown renders on
   * every main/community feed page (main-page-layout.tsx, community-layout.tsx),
   * public surfaces with no auth boundary. `user.isLoggedIn` cannot answer during
   * SSR and reports "signed out" on the client until `/api/users/me` returns, so
   * the "My friends" / "My communities" rows — and the personalized trending list
   * below them — were missing from a signed-in reader's dropdown for up to several
   * seconds after every page load. See features/layouts/server-session.tsx.
   */
  const identity = useSessionIdentity();
  const router = useRouter();
  const { t } = useTranslation('common_blog');
  const ssrObserver = useSSRObserver();
  const initialCommunities = useInitialCommunities();
  const initialSubscriptions = useInitialSubscriptions();
  const clientObserver = chainObserver(user);
  const observer = isHydrated ? clientObserver : ssrObserver;
  const sort = 'rank';
  const query = null;

  const { isLoading, data } = useQuery({
    queryKey: ['communitiesList', sort, query, observer],
    queryFn: () => fetchCommunities(sort, query, observer),
    initialData: initialCommunities ?? undefined,
    initialDataUpdatedAt: initialCommunities ? Date.now() : undefined,
    staleTime: StaleTime.LONG
  });
  const { data: mySubsData } = useQuery({
    queryKey: ['subscriptions', observer],
    queryFn: () => fetchSubscriptions(observer),
    enabled: observer !== DEFAULT_OBSERVER,
    initialData: initialSubscriptions ?? undefined,
    initialDataUpdatedAt: initialSubscriptions ? Date.now() : undefined,
    staleTime: StaleTime.LONG
  });
  const filteredCommunity = data
    ?.slice(0, 12)
    .filter((c) => !mySubsData?.map((my) => my[0]).includes(c.name));

  if (isLoading) return <p>{t('global.loading')}...</p>;
  return (
    <Select
      onValueChange={(e) => {
        if (e === 'communities') {
          router.push(withBasePath('/communities'));
        } else if (e.startsWith('/') || e.startsWith('@')) {
          router.push(withBasePath(e));
        } else {
          // ★ `/topics/`, not the retired `/trending/` (2026-08-18). This branch takes a
          // bare community/tag name and builds a route for it; `/trending/:tag` is a 307
          // to exactly this destination, so going straight there saves a redirect and
          // stops this depending on a route that is slated for deletion.
          router.push(withBasePath(`/topics/${e}`));
        }
      }}
    >
      {/* Same class as post-select-filter.tsx: role="combobox" does not get an
          accessible name from content, so the visible current value/title left
          this nameless (verified via the a11y tree). `title` itself is not a
          safe aria-label — it is the CURRENT selection/community, not the
          control's stable purpose — so this names the control generically. */}
      <SelectTrigger className="bg-surface-1" aria-label={t('communities.communities')}>
        <SelectValue placeholder={title} />
      </SelectTrigger>
      <SelectContent
        className="max-h-96 overflow-y-auto"
        ref={(ref) => {
          if (!ref) return;
          ref.ontouchstart = (e) => {
            e.preventDefault();
          };
        }}
      >
        <SelectGroup>
          <SelectItem value="/">{t('navigation.communities_nav.all_posts')}</SelectItem>
        </SelectGroup>
        {identity.isLoggedIn && (
          <SelectGroup>
            <SelectItem value={`/@${identity.username}/feed`}>My friends</SelectItem>
            <SelectItem value="/?tab=feed">My communities</SelectItem>
            {mySubsData && mySubsData.length > 0 ? (
              <SelectItem disabled value="my-communities" className="text-ink-info-10">
                My communities
              </SelectItem>
            ) : null}
            {mySubsData && mySubsData.length > 0
              ? mySubsData?.map((e) => (
                  <SelectItem key={e[0]} value={e[0]}>
                    {e[1]}
                  </SelectItem>
                ))
              : null}
          </SelectGroup>
        )}
        <SelectGroup>
          <SelectItem disabled value="trending-communities" className="text-ink-info-10">
            {t('navigation.communities_nav.trending_communities')}
          </SelectItem>
          {identity.isLoggedIn
            ? filteredCommunity?.slice(0, 12).map((community) => (
                <SelectItem key={community.id} value={community.name}>
                  {community.title}
                </SelectItem>
              ))
            : data?.slice(0, 12).map((community) => (
                <SelectItem key={community.id} value={community.name}>
                  {community.title}
                </SelectItem>
              ))}
          <SelectItem value="communities">{t('navigation.communities_nav.explore_communities')}</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
