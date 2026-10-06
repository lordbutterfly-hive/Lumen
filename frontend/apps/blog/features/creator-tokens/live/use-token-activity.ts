'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { getCreatorTokensDataSource } from '../lib/creator-tokens-data-source';
import type { TokenActivityCursor, TokenActivityGroup, TokenActivityPage, TokenActivityScope } from '../lib/vsc/token-activity';

export const tokenActivityKey = (scope: TokenActivityScope | null, group: TokenActivityGroup) =>
  ['creatorTokens', 'live', 'activity', scope?.kind ?? 'none', scope ? (scope.kind === 'token' ? scope.creator : scope.account) : '', group] as const;

/**
 * Token movements, page by page, for the active tab: the creator page's
 * Transactions and the wallet's Meritum activity.
 *
 * Same grammar as the Magi tab's use-magi-history.ts: one indexer request per
 * page (every table in one GraphQL document, never a request per row), a
 * cursor rather than an offset, and the 45 s poll only while the reader is on
 * the newest page, because only that page can gain rows.
 */
export function useTokenActivity(scope: TokenActivityScope | null, group: TokenActivityGroup) {
  const dataSource = getCreatorTokensDataSource();
  return useInfiniteQuery<TokenActivityPage>({
    queryKey: tokenActivityKey(scope, group),
    queryFn: ({ pageParam }) => dataSource!.readTokenActivity(scope!, group, (pageParam as TokenActivityCursor | undefined) ?? null),
    getNextPageParam: (lastPage) => lastPage.next ?? undefined,
    enabled: scope !== null && dataSource !== null,
    refetchInterval: (data) => ((data?.pages.length ?? 1) <= 1 ? 45_000 : false),
    retry: 1
  });
}
