'use client';

import { useMemo, useState } from 'react';
import { Icons } from '@ui/components/icons';
import { UseInfiniteQueryResult } from '@tanstack/react-query';
import { IFollow } from '@hive/common-hiveio-packages/wax';
import { User } from '@smart-signer/types/common';
import { numberWithCommas } from '@ui/lib/utils';
import { useTranslation } from '@/blog/i18n/client';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import FollowListRow from './follow-list-row';
import FollowListSkeleton from './follow-list-skeleton';
import FollowRowActions from './follow-row-actions';
import { useFollowListSearch, type FollowListVariant } from './use-follow-list-search';
import {
  EMPTY_TITLE,
  LIST_CARD,
  META_TEXT,
  PAGER_BUTTON,
  SEARCH_INPUT
} from './tokens';

export interface FollowListEntry {
  username: string;
  /** Optimistic row, not yet on chain. */
  temporary?: boolean;
}

/**
 * The whole body of `/@user/followers` and `/@user/following`: toolbar, one
 * list card, and one pagination block underneath it.
 *
 * ★ WIDTH. The old body was wrapped in `div.p-2`, so the list measured 16px
 * narrower than the masthead directly above it (815 vs 831 at the spec's
 * viewport; 736 vs 752 at 1440) and the left and right edges of the page did
 * not line up. There is no horizontal padding here: the card is the column.
 *
 * ★ PAGINATION IS RENDERED ONCE, BELOW THE LIST. It used to be rendered twice,
 * with a non-grammatical "Followers page 1 from 54" sentence above AND below
 * it, four chrome blocks around a 50-row list.
 */
export default function FollowListView({
  variant,
  account,
  items,
  loadedNames,
  isLoading,
  totalCount,
  page,
  totalPages,
  hasNextPage,
  hasPrevPage,
  isPageLoading,
  onNextPage,
  onPrevPage,
  user,
  follow,
  mute
}: {
  variant: FollowListVariant;
  /** Whose list this is. */
  account: string;
  /** The current page of rows, already cross-filtered by the caller. */
  items: FollowListEntry[];
  /** Every name across every page fetched so far — the search's local half. */
  loadedNames: string[];
  isLoading: boolean;
  totalCount?: number;
  /** Zero-based. */
  page: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
  isPageLoading: boolean;
  onNextPage: () => void;
  onPrevPage: () => void;
  user: User;
  follow: UseInfiniteQueryResult<IFollow[], unknown>;
  mute: UseInfiniteQueryResult<IFollow[], unknown>;
}) {
  const { t } = useTranslation('common_blog');
  const identity = useSessionIdentity();
  const [rawQuery, setRawQuery] = useState('');

  const search = useFollowListSearch({ account, variant, rawQuery, loadedNames });

  const rows: FollowListEntry[] = useMemo(
    () => (search.active ? search.names.map((username) => ({ username })) : items),
    [search.active, search.names, items]
  );

  const countLabel =
    totalCount === undefined
      ? null
      : variant === 'followers'
        ? t('user_profile.lists.count_followers', {
            count: totalCount,
            value: numberWithCommas(String(totalCount))
          })
        : t('user_profile.lists.count_following', { value: numberWithCommas(String(totalCount)) });

  // A row gets controls only for a signed-in reader looking at somebody else.
  // Same rule both pages already applied; it lives here now instead of being
  // re-typed per page.
  const showActionsFor = (username: string) => identity.isLoggedIn && identity.username !== username;

  const body = () => {
    if (isLoading)
      return (
        <FollowListSkeleton
          label={t(variant === 'followers' ? 'global.loading_followers' : 'global.loading_following')}
        />
      );

    if (search.active && rows.length === 0) {
      return (
        <div className={LIST_CARD} data-testid="follow-list-card">
          <div
            className="flex flex-col items-center gap-2 px-6 py-14 text-center"
            data-testid="follow-list-no-results"
          >
            <p className={EMPTY_TITLE}>
              {variant === 'followers'
                ? t('user_profile.lists.no_results_followers', { query: search.query })
                : t('user_profile.lists.no_results_following', { query: search.query })}
            </p>
            {search.isSearching ? (
              <p className={META_TEXT}>{t('user_profile.lists.searching')}</p>
            ) : (
              <button
                type="button"
                onClick={() => setRawQuery('')}
                data-testid="follow-list-clear-search"
                className="font-sans text-caption font-semibold text-ink-brand-6 hover:underline"
              >
                {t('user_profile.lists.clear_search')}
              </button>
            )}
          </div>
        </div>
      );
    }

    if (!search.active && rows.length === 0) {
      /*
       * ★ AN EMPTY LIST NEXT TO A NON-ZERO COUNT IS A FAILURE, NOT AN EMPTY LIST
       * (2026-08-16, found by a QA pass).
       *
       * `/api/following` answered 502 — upstream rate-limiting under load — and
       * this card rendered "Not following anyone yet. Accounts @lauramica
       * follows show up here." directly beneath its OWN header reading "851
       * following", with the pagination footer still offering "Page 1 of 18".
       * Three parts of one screen disagreeing, and the one a reader believes is
       * the sentence, because it is the one written in words.
       *
       * `totalCount` comes from a different call that had succeeded, so the
       * contradiction is detectable right here without threading an error flag
       * through four components: if the count says there are some and we have
       * none, we did not learn that they have nobody — we failed to find out.
       * Say that instead, because "nobody follows them" is a claim about another
       * person that we have no evidence for.
       */
      const loadFailed = typeof totalCount === 'number' && totalCount > 0;
      return (
        <div className={LIST_CARD} data-testid="follow-list-card">
          <div
            className="flex flex-col items-center gap-1.5 px-6 py-14 text-center"
            data-testid={loadFailed ? 'follow-list-unavailable' : 'follow-list-empty'}
          >
            <p className={EMPTY_TITLE}>
              {loadFailed
                ? t('user_profile.lists.list_unavailable_title')
                : t(
                variant === 'followers'
                  ? 'user_profile.lists.empty_followers_title'
                  : 'user_profile.lists.empty_following_title'
              )}
            </p>
            <p className="font-sans text-caption font-normal italic text-[#6b7280]">
              {loadFailed
                ? t('user_profile.lists.list_unavailable_body')
                : t(
                variant === 'followers'
                  ? 'user_profile.lists.empty_followers_body'
                  : 'user_profile.lists.empty_following_body',
                { username: account }
              )}
            </p>
          </div>
        </div>
      );
    }

    return (
      <div className={LIST_CARD} data-testid="follow-list-card">
        <ul>
          {rows.map((entry) => (
            <FollowListRow
              key={entry.username}
              username={entry.username}
              temporary={entry.temporary}
              actions={
                showActionsFor(entry.username) ? (
                  <FollowRowActions
                    username={entry.username}
                    user={user}
                    follow={follow}
                    mute={mute}
                  />
                ) : null
              }
            />
          ))}
        </ul>
      </div>
    );
  };

  return (
    <div className="flex w-full flex-col" data-testid="follow-list-page">
      <div className="mb-4 flex h-12 items-center justify-between gap-4">
        <div className="relative w-full max-w-[300px]">
          <Icons.search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-14"
            aria-hidden
          />
          <input
            type="search"
            value={rawQuery}
            onChange={(event) => setRawQuery(event.target.value)}
            spellCheck={false}
            autoComplete="off"
            aria-label={t(
              variant === 'followers'
                ? 'user_profile.lists.search_followers'
                : 'user_profile.lists.search_following'
            )}
            placeholder={t(
              variant === 'followers'
                ? 'user_profile.lists.search_followers'
                : 'user_profile.lists.search_following'
            )}
            data-testid="follow-list-search"
            className={SEARCH_INPUT}
          />
          {rawQuery ? (
            <button
              type="button"
              onClick={() => setRawQuery('')}
              aria-label={t('user_profile.lists.clear_search')}
              data-testid="follow-list-search-clear"
              className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-control text-ink-14 transition-colors hover:bg-[#f4f5f7] hover:text-[#3f4650]"
            >
              <Icons.x className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
        {countLabel ? (
          <span className={META_TEXT} data-testid="follow-list-count">
            {countLabel}
          </span>
        ) : null}
      </div>

      {body()}

      {/* Hidden while a search is open: the result set is not a page of the
          underlying cursor, so "Page 1 of 54" would be a claim about something
          the reader is not looking at. */}
      {!search.active && !isLoading && totalPages > 1 ? (
        <div
          className="mt-5 flex items-center justify-center gap-4"
          data-testid="follow-list-pagination"
        >
          <button
            type="button"
            className={PAGER_BUTTON}
            disabled={!hasPrevPage}
            onClick={onPrevPage}
            data-testid="follow-list-prev"
          >
            {t('user_profile.lists.list.previous_button')}
          </button>
          <span className={META_TEXT} data-testid="follow-list-page-label">
            {t('user_profile.lists.page_of', { current: page + 1, total: totalPages })}
          </span>
          <button
            type="button"
            className={PAGER_BUTTON}
            disabled={!hasNextPage || isPageLoading}
            onClick={onNextPage}
            data-testid="follow-list-next"
          >
            {t('user_profile.lists.list.next_button')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
