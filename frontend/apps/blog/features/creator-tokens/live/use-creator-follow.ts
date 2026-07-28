'use client';

/**
 * Following a creator is a LUMEN-LOCAL preference, not a chain action — there
 * is no follow entrypoint on the contract and there should not be one.
 *
 * Extracted out of market/store.ts (2026-07-28) so the token page can stop
 * importing that module entirely. store.ts is the in-memory demo whose numbers
 * vanish on refresh; leaving one import of it on a live screen would keep the
 * whole fabricated market graph alive in the bundle and one careless call away
 * from being rendered.
 *
 * Deliberately in-memory for now, exactly as the demo was: persisting a follow
 * belongs with the rest of the follow graph (features/mute-follow), not in a
 * token-page-local store, and inventing a second source of truth for it here
 * would be the harder thing to unpick later.
 */

import { useCallback, useSyncExternalStore } from 'react';

const followed = new Set<string>();
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCreatorFollow(handle: string): { following: boolean; toggle: () => void } {
  const following = useSyncExternalStore(
    subscribe,
    () => followed.has(handle),
    () => followed.has(handle)
  );
  const toggle = useCallback(() => {
    if (followed.has(handle)) followed.delete(handle);
    else followed.add(handle);
    emit();
  }, [handle]);
  return { following, toggle };
}
