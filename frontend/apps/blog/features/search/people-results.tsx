'use client';

import { useQuery } from '@tanstack/react-query';
import { LumenLoader, UserAvatarImg } from '@hive/ui';
import BasePathLink from '@/blog/components/base-path-link';
import { EmptyStateIllustration } from '@/blog/components/empty-state-illustration';
import { useTranslation } from '@/blog/i18n/client';
import { StaleTime } from '@/blog/lib/react-query';
import { fetchSearchPeople, type SearchPersonWire } from '@/blog/lib/chain-fetch';
import { isBlockedEntry, useLumenBlockList } from '@/blog/lib/lite/client/use-lumen-block';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';

/**
 * The People tab of /search (2026-09-05). Two sections, two requests:
 *
 *   * "Matching names": accounts whose name starts with the query (Hive via
 *     hived's account index, Lumen lite via Postgres), ~0.5s;
 *   * "People who write about": accounts Hivesense ranks as thematically close
 *     to the query, 2 to 3s and optional.
 *
 * They are separate queries on purpose: the fast section is on screen while
 * the slow one runs, and a Hivesense outage loses one optional section rather
 * than the tab (the section simply does not render; there is no error card for
 * something the reader did not ask for by name).
 *
 * Same list hygiene as every other list surface: the reader's own block list
 * filters here (`isBlockedEntry`), banned accounts are dropped server-side.
 */
const PeopleResults = ({ query }: { query: string }) => {
  const { t } = useTranslation('common_blog');
  const { user } = useUserClient();
  const blockList = useLumenBlockList(Boolean(user?.isLoggedIn));

  const byName = useQuery({
    queryKey: ['searchPeople', 'prefix', query],
    queryFn: ({ signal }) => fetchSearchPeople(query, 'prefix', signal),
    enabled: !!query,
    retry: 1,
    staleTime: StaleTime.MEDIUM,
    refetchOnWindowFocus: false
  });
  const byTopic = useQuery({
    queryKey: ['searchPeople', 'topic', query],
    queryFn: ({ signal }) => fetchSearchPeople(query, 'topic', signal),
    enabled: !!query,
    retry: false,
    staleTime: StaleTime.LONG,
    refetchOnWindowFocus: false
  });

  const visible = (people: SearchPersonWire[] | undefined) =>
    (people ?? []).filter((person) => !isBlockedEntry({ author: person.name }, blockList));
  const names = visible(byName.data);
  const seen = new Set(names.map((person) => person.name));
  const topical = visible(byTopic.data).filter((person) => !seen.has(person.name));
  const total = names.length + topical.length;

  const settled = !byName.isLoading && !byTopic.isLoading;
  const bothFailed = byName.isError && byTopic.isError;

  const header = (
    <p className="font-sans text-[14px] leading-[22px] text-ink-10" data-testid="search-people-count">
      {!settled && total === 0
        ? t('search_page.searching_people', { query, defaultValue: 'Searching people for “{{query}}”' })
        : t(total === 1 ? 'search_page.people_count_one' : 'search_page.people_count_other', {
            count: total,
            query,
            defaultValue: total === 1 ? '{{count}} person for “{{query}}”' : '{{count}} people for “{{query}}”'
          })}
    </p>
  );

  if (settled && bothFailed) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <p className="py-10 text-center font-sans text-sm text-muted-foreground" data-testid="search-people-error">
          {t('search_page.people_unavailable', {
            defaultValue: 'People search is not available right now. Try again in a moment.'
          })}
        </p>
      </div>
    );
  }

  if (settled && total === 0) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <div className="flex flex-col items-center gap-4 py-10 text-center" data-testid="search-people-empty">
          <EmptyStateIllustration name="no-results" size={128} />
          <p className="font-sans text-sm text-muted-foreground">
            {t('search_page.no_people_for', {
              query,
              defaultValue: 'No people found for “{{query}}”. Try a name, or a topic they write about.'
            })}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {header}
      {byName.isLoading && names.length === 0 ? (
        <LumenLoader size="lg" label={t('global.loading_search_results')} />
      ) : null}
      {names.length > 0 ? (
        <PeopleSection
          title={t('search_page.people_matching_names', { defaultValue: 'Matching names' })}
          people={names}
          testId="search-people-names"
        />
      ) : null}
      {topical.length > 0 ? (
        <PeopleSection
          title={t('search_page.people_writing_about', { query, defaultValue: 'People who write about “{{query}}”' })}
          people={topical}
          testId="search-people-topic"
        />
      ) : byTopic.isLoading && names.length > 0 ? (
        <p className="font-sans text-caption text-ink-14">
          {t('search_page.people_topic_loading', { defaultValue: 'Looking for people who write about this…' })}
        </p>
      ) : null}
    </div>
  );
};

function PeopleSection({ title, people, testId }: { title: string; people: SearchPersonWire[]; testId: string }) {
  return (
    <section className="flex flex-col gap-3" data-testid={testId}>
      <h2 className="font-sans text-[13px] font-semibold uppercase tracking-[0.06em] text-ink-14">{title}</h2>
      <ul className="w-full overflow-hidden rounded-panel border border-line-9 bg-surface-1">
        {people.map((person) => (
          <PersonCard key={`${person.kind}:${person.name}`} person={person} />
        ))}
      </ul>
    </section>
  );
}

/**
 * One row: avatar, display name, `@name`, reputation, one line of bio, counts.
 * The whole row is one destination (`/@name`), the same way a follow-list row
 * is; the avatar link is `aria-hidden` so a screen reader hears the name once.
 */
function PersonCard({ person }: { person: SearchPersonWire }) {
  const { t } = useTranslation('common_blog');
  const href = `/@${person.name}`;
  const showDisplayName = person.displayName && person.displayName.toLowerCase() !== person.name;
  return (
    <li
      className="flex items-start gap-3 border-b border-line-9 px-4 py-3 transition-colors last:border-b-0 hover:bg-surface-21/50"
      data-testid="search-person-card"
    >
      <BasePathLink href={href} className="mt-0.5 shrink-0" tabIndex={-1} aria-hidden>
        <UserAvatarImg
          username={person.name}
          pixelSize={44}
          radiusClassName="rounded-control"
          src={person.avatarUrl ?? undefined}
        />
      </BasePathLink>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <BasePathLink
            href={href}
            className="truncate font-sans text-[15px] font-semibold leading-[22px] text-ink-2 hover:underline"
            data-testid="search-person-name"
          >
            {showDisplayName ? person.displayName : person.name}
          </BasePathLink>
          {showDisplayName ? <span className="font-sans text-caption text-ink-10">@{person.name}</span> : null}
          {person.reputation !== null ? (
            <span
              className="rounded-full border border-line-9 px-1.5 font-sans text-[11px] leading-[18px] text-ink-10"
              title={t('search_page.people_reputation', {
                value: person.reputation.toFixed(2),
                defaultValue: 'Reputation {{value}}'
              })}
            >
              {Math.round(person.reputation)}
            </span>
          ) : null}
          {person.kind === 'lite' ? (
            <span className="rounded-full bg-surface-21 px-1.5 font-sans text-[11px] leading-[18px] font-medium text-ink-10">
              {t('search_page.suggest_lite_badge', { defaultValue: 'Lumen' })}
            </span>
          ) : null}
        </div>
        {person.about ? <p className="truncate font-sans text-sm text-ink-10">{person.about}</p> : null}
        {person.followers !== null || person.postCount !== null ? (
          <p className="font-sans text-caption text-ink-14">
            {person.followers !== null
              ? t(person.followers === 1 ? 'search_page.people_followers_one' : 'search_page.people_followers_other', {
                  count: person.followers,
                  defaultValue: person.followers === 1 ? '{{count}} follower' : '{{count}} followers'
                })
              : null}
            {person.followers !== null && person.postCount !== null ? ' · ' : null}
            {person.postCount !== null
              ? t(person.postCount === 1 ? 'search_page.people_posts_one' : 'search_page.people_posts_other', {
                  count: person.postCount,
                  defaultValue: person.postCount === 1 ? '{{count}} post' : '{{count}} posts'
                })
              : null}
          </p>
        ) : null}
      </div>
    </li>
  );
}

export default PeopleResults;
