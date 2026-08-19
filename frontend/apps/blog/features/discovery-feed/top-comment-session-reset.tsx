'use client';

import { useEffect, useRef } from 'react';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { resetTopCommentPicks } from './lib/top-comment';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE OTHER END OF `resetTopCommentPicks()`.
 *
 * `lib/top-comment.ts` caches which comment a post card opens onto in a
 * MODULE-LEVEL Map, deliberately, so the card does not change its mind between
 * one hover and the next. Its own header says the cache "must be called on
 * logout and on a feed reset so a session's picks do not outlive it" — and until
 * now `resetTopCommentPicks()` had ZERO callers. The requirement was written
 * down and never wired, which is the failure mode where a function exists, reads
 * as done, and does nothing.
 *
 * ★ WHY THIS WATCHES IDENTITY RATHER THAN HOOKING THE LOGOUT BUTTON.
 * There is no single logout call site to hook. Sign-out reaches the client from
 * at least four directions:
 *
 *   1. the user menu           -> `useLogout()` (site-header/user-menu.tsx)
 *   2. "sign out everywhere"   -> `signOutMutation` direct (security-panel.tsx)
 *   3. an `auth-storage-desync` event (use-user-core.tsx) resetting to logged-out
 *   4. `/api/users/me` answering that the cookie is no longer good
 *
 * Hooking only #1 would leave the other three carrying the previous session's
 * picks. But every one of them ends the same way: they write `[QUERY_KEY.user]`
 * through `setQueryData`, which `useUserClient` observes. So identity is the
 * choke point all four pass through, and watching it also covers the case nobody
 * listed — switching from one account straight to another without a reload.
 *
 * ★ WHY IT WAITS FOR `isHydrated`. Before hydration `useUserCore` deliberately
 * returns `defaultUser` whatever the real session is, to avoid a server/client
 * mismatch. So the first client render ALWAYS reports logged-out and the second
 * reports the truth. Treating that as a logout would fire a reset on every page
 * load — noise that would make a real reset impossible to tell from boot. The
 * baseline is therefore only recorded once hydration says the value is real.
 *
 * ★ A module-level Map is per page LOAD, so a hard navigation clears it anyway.
 * This exists for the case that is not a page load: signing out in place, where
 * the React tree, and therefore the Map, survives.
 *
 * Renders nothing. Mounted once, globally, in `features/layouts/providers.tsx`.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export default function TopCommentSessionReset() {
  const { user, isHydrated } = useUserClient();
  // Logged out is its own identity, not "no identity" — the transition
  // logged-in -> logged-out is precisely the one this exists for.
  const identity = user?.isLoggedIn ? user.username : '';
  const previous = useRef<string | null>(null);

  useEffect(() => {
    if (!isHydrated) return;
    // `null` means "no baseline yet", which is different from `''` (signed out).
    // Only a CHANGE between two real readings is a session ending.
    if (previous.current !== null && previous.current !== identity) {
      resetTopCommentPicks();
    }
    previous.current = identity;
  }, [identity, isHydrated]);

  return null;
}
