'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchSearchSuggestions, type SearchSuggestionsWire } from '@/blog/lib/chain-fetch';
import { isSuggestable, normalizeSearchText } from '@/blog/lib/search/query';

/**
 * 200ms: long enough that a typist's next key usually lands before the
 * request fires (measured keystroke gaps are 80 to 150ms), short enough that
 * a pause reads as "it answered", not "it is thinking".
 */
const DEBOUNCE_MS = 200;

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export interface SearchSuggestionsState {
  /** The answer for the DEBOUNCED text; `null` when the text is too short or the field is closed. */
  suggestions: SearchSuggestionsWire | null;
  isFetching: boolean;
  isError: boolean;
}

/**
 * ★ REACT QUERY, NOT A HAND-ROLLED FETCH. Three things come for free that a
 * `useEffect` + `fetch` version has to get right by hand: the AbortSignal
 * (a superseded request is cancelled, so "phot" can never paint after
 * "photo"), one shared cache between the desktop and the mobile field (they
 * are two instances of the same component), and `keepPreviousData`, which keeps
 * the last list on screen while the next one loads instead of flashing empty
 * between keystrokes.
 *
 * `retry: false`: a suggestion that fails is worth nothing a second later, and
 * the action rows render regardless. `staleTime` matches the server memo.
 */
export function useSearchSuggestions(text: string, enabled: boolean): SearchSuggestionsState {
  const debounced = useDebounced(text, DEBOUNCE_MS);
  const query = normalizeSearchText(debounced);
  const active = enabled && isSuggestable(query);
  const { data, isFetching, isError } = useQuery({
    queryKey: ['search-suggest', query.toLowerCase()],
    queryFn: ({ signal }) => fetchSearchSuggestions(query, signal),
    enabled: active,
    staleTime: 60_000,
    retry: false,
    keepPreviousData: true,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false
  });
  return {
    suggestions: active ? (data ?? null) : null,
    isFetching: active && isFetching,
    isError: active && isError
  };
}
