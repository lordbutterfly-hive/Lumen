'use client';

import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { fetchAccount, fetchDynamicGlobalProperties } from '@/blog/lib/chain-fetch';

/**
 * ★ THE AUTHOR CARD STARTS LOADING WHEN THE POINTER RESTS ON THE NAME (2026-09-25,
 * owner: "it loads a bit slow"). The card's slowest read is `/api/account`, measured
 * at 260-370 ms on the origin for a name nobody has asked about in 15 s. It used to
 * start on the click; now it starts after the pointer has rested on the name for
 * 80 ms, so by the time the click lands the reply is usually in the cache.
 *
 * Same intent rules as components/intent-prefetch.tsx (80 ms of rest, never on
 * touch, where a tap fires pointerenter right before click anyway), and the same
 * query keys as useAccountQuery / useDynamicGlobalData so the card reads what this
 * warmed. React Query's default staleTime (60 s, lib/react-query.ts) means a name
 * is fetched at most once a minute however often the pointer passes over it.
 *
 * Not the Inquisition record: that route spends the reader's shared request budget
 * (lib/request-budget.ts), so it is read only when a card actually opens.
 */
const REST_MS = 80;

export function useAuthorCardPrefetch(author: string) {
  const queryClient = useQueryClient();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancel = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  useEffect(() => cancel, [cancel]);

  const onPointerEnter = useCallback(
    (event: ReactPointerEvent<Element>) => {
      if (!author || event.pointerType !== 'mouse') return;
      cancel();
      timer.current = setTimeout(() => {
        timer.current = null;
        void queryClient.prefetchQuery({ queryKey: ['accountData', author], queryFn: () => fetchAccount(author) });
        void queryClient.prefetchQuery({ queryKey: ['dynamicGlobalData'], queryFn: () => fetchDynamicGlobalProperties() });
      }, REST_MS);
    },
    [author, cancel, queryClient]
  );

  return { onPointerEnter, onPointerLeave: cancel };
}
