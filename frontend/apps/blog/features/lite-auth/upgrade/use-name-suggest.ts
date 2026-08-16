'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Name availability for the upgrade screen, with alternatives.
 *
 * Deliberately NOT `useLiteLogin`'s `checkName`. Signup only needs yes/no, because a
 * Lumen handle is ours to give. A Hive name is not: the user's own handle may already
 * belong to a stranger, so this screen has to answer "no" and "here is what you can
 * have instead" in the same breath — one request, one rate-limit unit.
 */

export type SuggestState =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available' }
  | { state: 'unavailable'; reason: string; suggestions: string[] };

interface SuggestResponse {
  baseAvailable?: boolean;
  baseReason?: string;
  suggestions?: string[];
}

const DEBOUNCE_MS = 350;

export function useNameSuggest() {
  const [status, setStatus] = useState<SuggestState>({ state: 'idle' });
  const timer = useRef<ReturnType<typeof setTimeout>>();
  // Guards against an older, slower response overwriting a newer one — the user keeps
  // typing while requests are in flight.
  const seq = useRef(0);
  const alive = useRef(true);

  /**
   * On unmount: drop any pending debounce and stop writing state.
   *
   * This screen navigates away as soon as the user confirms their keys, so a debounce
   * armed a moment earlier would otherwise fire into a dead component — and, worse,
   * spend one of the shared per-IP name-lookup units on an answer nobody will see.
   */
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const check = useCallback((raw: string) => {
    if (timer.current) clearTimeout(timer.current);
    const name = raw.trim().toLowerCase();
    if (!name) {
      setStatus({ state: 'idle' });
      return;
    }
    setStatus({ state: 'checking' });
    const mine = ++seq.current;

    timer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/lite/name/suggest?name=${encodeURIComponent(name)}`);
        if (!alive.current || mine !== seq.current) return;
        if (!res.ok) {
          setStatus({
            state: 'unavailable',
            reason:
              res.status === 429
                ? 'Too many checks. Wait a moment and try again.'
                : 'Could not check that name right now.',
            suggestions: []
          });
          return;
        }
        const body = (await res.json()) as SuggestResponse;
        if (!alive.current || mine !== seq.current) return;
        setStatus(
          body.baseAvailable
            ? { state: 'available' }
            : {
                state: 'unavailable',
                reason: body.baseReason || 'That name isn’t available.',
                suggestions: body.suggestions ?? []
              }
        );
      } catch {
        if (alive.current && mine === seq.current) {
          setStatus({
            state: 'unavailable',
            reason: 'Could not check that name right now.',
            suggestions: []
          });
        }
      }
    }, DEBOUNCE_MS);
  }, []);

  return { status, check };
}
