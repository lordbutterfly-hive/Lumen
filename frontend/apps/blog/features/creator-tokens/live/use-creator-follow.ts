'use client';

/**
 * Following a creator from their token page — the SAME follow as everywhere else
 * in Lumen, not a token-page-local one.
 *
 * ★ REWIRED 2026-08-07. This used to be a module-level `Set<string>` keyed only by
 * the creator's handle: no server call, no persistence, no idea who was asking.
 * QA caught it three ways — clicking Follow fired zero network requests, the
 * state vanished on reload, and because the set was keyed by handle alone, two
 * different people signed into the same tab shared one toggle. A control that
 * reports success and changes nothing is worse than no control.
 *
 * `useLumenFollow` is the real thing (`/api/lite/follow`, `/api/lite/follow/state`)
 * and is already what the profile pages use, so a follow made here shows up there
 * and vice versa. It also re-reads from the server after a toggle instead of
 * flipping locally, so a refusal (rate limit, suspension) shows the truth.
 *
 * Following remains a LUMEN-LOCAL relationship — there is no follow entrypoint on
 * the contract and there should not be one. That was always right; the mistake
 * was implementing it in browser memory instead of in the follow graph.
 */

import { useCallback } from 'react';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useLumenFollow } from '@/blog/lib/lite/client/use-lumen-follow';

export function useCreatorFollow(handle: string): {
  following: boolean;
  /** True while the follow state is unknown, or a toggle is in flight — the button must not claim either state. */
  busy: boolean;
  /** Signed out, or the relationship does not apply: the control should not be offered. */
  available: boolean;
  toggle: () => void;
} {
  const { user, isHydrated } = useUserClient();
  const loggedIn = isHydrated && user.isLoggedIn;
  const follow = useLumenFollow(handle, loggedIn);

  const toggle = useCallback(() => {
    if (!loggedIn) return;
    // The hook reports a refusal as a message rather than throwing; there is no
    // toast surface on this control, so the re-read it performs is what corrects
    // the button. Never flip optimistically — that is how the old one lied.
    void follow.toggle();
  }, [loggedIn, follow]);

  return {
    following: follow.isFollowing,
    busy: follow.busy || follow.pending,
    // `applies` is the server's answer to "can this person be followed at all".
    // Some creators are not followable accounts — the one deployed testnet market
    // belongs to a contract-deployer identity with no Lumen or Hive presence — and
    // offering a Follow button there produced a click that could never succeed.
    // Hidden until the server has answered, so the button never claims a state it
    // does not know.
    available: loggedIn && follow.applies,
    toggle
  };
}
