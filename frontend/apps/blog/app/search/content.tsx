'use client';

import LeftRail from '@/blog/features/layouts/left-rail';
import RightRail from '@/blog/features/layouts/right-rail';
import AccountTopicResult from '@/blog/features/search/account-topic-result';
import AIResult from '@/blog/features/search/ai-result';
import { DEFAULT_PREFERENCES, Preferences } from '@/blog/lib/utils';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useTranslation } from '@/blog/i18n/client';
import { useQuery } from '@tanstack/react-query';
import { getHiveSenseStatus } from '@transaction/lib/hivesense-api';
import { ModeSwitchInput } from '@ui/components/mode-switch-input';
import { SearchSort } from '@ui/hooks/use-search';
import { useStorageWithTTL } from '@ui/hooks/useStorageWithTTL';
import { StorageTTL } from '@ui/lib/storage-with-ttl';
import type { Entry, MixedPostsResponse } from '@hive/common-hiveio-packages/wax';

interface SearchContentProps {
  aiParam: string | undefined;
  classicQuery: string | undefined;
  userTopicQuery: string | undefined;
  topicQuery: string | undefined;
  sortQuery: SearchSort;
  initialAIResults?: MixedPostsResponse | null;
  initialClassicResults?: Entry[] | null;
  initialTopicResults?: Entry[] | null;
}

const SearchContent = ({
  aiParam,
  classicQuery,
  userTopicQuery,
  topicQuery,
  sortQuery,
  initialAIResults,
  initialClassicResults,
  initialTopicResults
}: SearchContentProps) => {
  const { data: hiveSense } = useQuery({
    queryKey: ['hivesense-api'],
    queryFn: () => getHiveSenseStatus(),
    refetchOnWindowFocus: false,
    refetchOnMount: false
  });
  const { t } = useTranslation('common_blog');
  const { user } = useUserClient();
  const [preferences] = useStorageWithTTL<Preferences>(
    user.username ? `user-preferences-${user.username}` : '',
    DEFAULT_PREFERENCES,
    StorageTTL.PERMANENT
  );
  return (
    // ★ THE LUMEN SHELL, NOT A BARE COLUMN (2026-08-08). Search rendered as a
    // centred max-w-4xl block with no left rail and none of the feed's framing,
    // so arriving here from the feed felt like leaving the product. Same three
    // columns, same gutters, same max width as home and topics.
    <div className="relative mx-auto grid max-w-[1720px] grid-cols-1 gap-11 px-6 pb-20 pt-[26px] md:grid-cols-[200px_minmax(0,1fr)] md:px-11 xl:grid-cols-[200px_minmax(0,1fr)_312px]">
      <div
        className="pointer-events-none absolute bottom-20 left-[244px] top-[26px] hidden w-px bg-[#ececec] md:block"
        aria-hidden
      />
      <aside className="sticky top-24 hidden h-fit md:block">
        <LeftRail />
      </aside>
      <main className="flex min-w-0 flex-col gap-8">
      <div className="flex flex-col gap-4">
        <div className="w-full">
          <ModeSwitchInput searchPage aiAvailable={!!hiveSense} />
        </div>
      </div>
      {/* ★ Nothing asked for yet. Without this the page rendered ONE stray
          control ("Sort by: Relevance") floating over blank space, which reads
          as a half-loaded page rather than an invitation to type. */}
      {!aiParam && !classicQuery && !userTopicQuery ? (
        <p className="py-10 text-center font-sans text-sm text-muted-foreground">
          {t('search_page.start_prompt')}
        </p>
      ) : null}
      {!!aiParam ? (
        <AIResult query={aiParam} nsfwPreferences={preferences.nsfw} initialData={initialAIResults} />
      ) : null}
      {!!classicQuery ? (
        <AccountTopicResult
          nsfwPreferences={preferences.nsfw}
          query={classicQuery}
          sort={sortQuery}
          initialData={initialClassicResults}
        />
      ) : null}
      {!!userTopicQuery && !!topicQuery ? (
        <AccountTopicResult
          author={userTopicQuery}
          query={userTopicQuery}
          sort={sortQuery}
          nsfwPreferences={preferences.nsfw}
          initialData={initialTopicResults}
        />
      ) : null}
      </main>
      <aside className="sticky top-24 hidden h-fit xl:block">
        <RightRail />
      </aside>
    </div>
  );
};

export default SearchContent;
