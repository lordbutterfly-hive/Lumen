'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchFollowers, fetchFollowing } from '@/blog/lib/chain-fetch';
import { StaleTime } from '@/blog/lib/react-query';

export type FollowListVariant = 'followers' | 'following';

/**
 * A Hive account name, which is the only thing this list ever contains. Used to
 * decide whether a typed query is worth sending upstream at all — anything with
 * a space, an uppercase letter or punctuation cannot name an account, so it is
 * answered from the already-loaded pages and never becomes a request.
 */
const ACCOUNT_NAME = /^[a-z0-9][a-z0-9.-]{1,15}$/;

/** One upstream page is enough: a prefix window of 100 covers any real query. */
const SEARCH_LIMIT = 100;

const DEBOUNCE_MS = 300;

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export interface FollowListSearch {
  /** The user has typed something worth filtering on. */
  active: boolean;
  /** Lower-cased, trimmed, debounced query — what the results below answer. */
  query: string;
  /** Matching account names, de-duplicated and alphabetical. */
  names: string[];
  /** An upstream prefix lookup is in flight for the current query. */
  isSearching: boolean;
}

/**
 * ★★★ WHY THIS IS NOT A PLAIN `Array.filter` (2026-08-13).
 *
 * The redesign spec asks for a search field that filters "client-side and
 * server-side as appropriate". A purely client-side filter would be a filter
 * over the ONE page of 50 rows that happens to be loaded — on a 2,661-follower
 * account that is 1.9% of the list, so searching for almost anybody returns
 * "no results" while the person is sitting on page 34. That is a control that
 * looks implemented and is not, which is worse than no control.
 *
 * `condenser_api.get_followers` / `get_following` return their rows in
 * ASCENDING ACCOUNT-NAME ORDER and take `start` as a lower-bound cursor — that
 * is already how this page's pagination advances (`getNextPageParam` hands the
 * last row's name back as the next `start`). Verified live against
 * api.hive.blog on 2026-08-13:
 *
 *     get_followers["lordbutterfly", "",     "blog", 5] -> a-0-0, a-0dime, a07, ...
 *     get_followers["lordbutterfly", "mark", "blog", 5] -> markegiles, markfriday, ...
 *
 * So a prefix search is one request: start the window AT the query and keep the
 * rows that still begin with it. That is the server-side half. It is unioned
 * with a substring match over every page already fetched, which is the
 * client-side half and is what makes an infix query ("butter") work at all.
 *
 * Nothing new is added to the network surface: `fetchFollowers`/`fetchFollowing`
 * are the same server routes the list itself reads through.
 */
export function useFollowListSearch({
  account,
  variant,
  rawQuery,
  loadedNames
}: {
  account: string;
  variant: FollowListVariant;
  rawQuery: string;
  /** Every name across every page fetched so far, for the client-side half. */
  loadedNames: string[];
}): FollowListSearch {
  const normalised = rawQuery.trim().toLowerCase();
  const query = useDebounced(normalised, DEBOUNCE_MS);
  const canAskServer = Boolean(account) && ACCOUNT_NAME.test(query);

  const serverMatches = useQuery({
    queryKey: ['followListSearch', variant, account, query],
    enabled: canAskServer,
    // A prefix window is stable enough to reuse while the reader keeps typing
    // and backspacing over the same few characters.
    staleTime: StaleTime.SHORT,
    queryFn: async () => {
      const rows =
        variant === 'followers'
          ? await fetchFollowers({ account, start: query, limit: SEARCH_LIMIT })
          : await fetchFollowing({ account, start: query, type: 'blog', limit: SEARCH_LIMIT });
      // The cursor is a LOWER BOUND, not a filter: querying "zzz" on an account
      // whose last follower is "zoe" returns the tail of the list, none of which
      // matches. Keep only the rows that really start with what was typed.
      return rows
        .map((row) => (variant === 'followers' ? row.follower : row.following))
        .filter((name) => typeof name === 'string' && name.toLowerCase().startsWith(query));
    }
  });

  const names = useMemo(() => {
    if (!query) return [];
    const found = new Set<string>();
    for (const name of loadedNames) {
      if (name.toLowerCase().includes(query)) found.add(name);
    }
    for (const name of serverMatches.data ?? []) found.add(name);
    return Array.from(found).sort((a, b) => a.localeCompare(b));
  }, [query, loadedNames, serverMatches.data]);

  return {
    active: query.length > 0,
    query,
    names,
    // Only true while a REAL upstream lookup is running: a query that cannot be
    // an account name never starts one, so the list must not claim to be busy.
    isSearching: canAskServer && serverMatches.isFetching
  };
}
