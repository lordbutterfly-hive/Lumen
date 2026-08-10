'use client';

import * as Sentry from "@sentry/nextjs";
import { transformError } from '@hive/transaction/lib/transform-error';
import ErrorToastContent from '@ui/components/error-toast-content';
import { toast, Toast } from '@ui/components/hooks/use-toast';
import env from "@beam-australia/react-env";
import { getLogger } from '@ui/lib/logging';

const logger = getLogger('app');

/** Patterns for user-cancelled operations — not errors, no toast needed */
const USER_CANCELLED_PATTERNS = [
  'No password from user',
  'rejected',
  'user rejected',
  'user denied',
  'user cancelled'
];

/**
 * Pattern for auth storage desync (IndexedDB cleared while session cookie remains).
 *
 * ★ NARROWED 2026-08-08. This used to match on the bare phrase "Auth for user .+ not
 * found" OR the bare string "AuthStorageMissingError" anywhere in an error's message —
 * matched via a plain substring/regex test, with no check on WHERE the error came
 * from. `handleError` is the shared catch-all for every mutation in the app, including
 * follow/unfollow/mute (see buttons-container.tsx, profile-actions.tsx,
 * use-follow-mutations.ts) — so ANY error whose message happened to contain that text,
 * from any of those unrelated call sites, would take this branch and call
 * `performDesyncLogout()`: an UNCONDITIONAL client wipe + a real POST to
 * `/api/auth/logout` that destroys the server session too. Confirmed live: mocking a
 * follow-endpoint failure with `message: "AuthStorageMissingError"` signed the account
 * out for real (`/api/users/me` went from isLoggedIn:true to false) even though nothing
 * about that account's key storage was actually involved.
 *
 * The `name === 'AuthStorageMissingError'` check above already catches a genuine
 * `AuthStorageMissingError` instance (own-property `name` survives a JSON round trip).
 * This regex is only the FALLBACK for a message that lost its class identity (e.g.
 * re-wrapped in a plain `Error`) — so it is anchored to the error's exact, full
 * message shape (`auth-error.ts`'s `` `Auth for user ${username} not found. Hint: add
 * ${keyType} key to safe storage.` ``) instead of a loose fragment any unrelated error
 * could coincidentally contain.
 */
const AUTH_STORAGE_DESYNC_PATTERN = /Auth for user .+ not found\.\s*Hint: add .+ key to safe storage\./i;

function isUserCancelled(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return USER_CANCELLED_PATTERNS.some(p => msg.toLowerCase().includes(p.toLowerCase()));
}

function isAuthStorageDesync(error: unknown): boolean {
  if (error && typeof error === 'object' && 'name' in error && error.name === 'AuthStorageMissingError') {
    return true;
  }
  const msg = error instanceof Error ? error.message : String(error);
  return AUTH_STORAGE_DESYNC_PATTERN.test(msg);
}

/**
 * Perform emergency logout when IndexedDB key storage is lost.
 * This runs outside React — clears cookie, posts to logout API,
 * and dispatches event for React Query to pick up.
 */
function performDesyncLogout(): void {
  // Clear observer cookie immediately — SSR stops personalizing
  document.cookie = 'observer=; path=/; max-age=0';

  // Clear user from localStorage so next page load starts logged out
  try {
    const defaultUser = JSON.stringify({
      isLoggedIn: false,
      username: '',
      avatarUrl: '',
      loginType: 'hbauth',
      keyType: 'posting',
      authenticateOnBackend: false
    });
    localStorage.setItem('user', defaultUser);
  } catch {
    // localStorage may be unavailable — cookie clear is sufficient
  }

  // POST to logout API to destroy server session (fire and forget)
  // Header value must match csrfHeaderName in @smart-signer/lib/csrf-protection.ts
  fetch('/api/auth/logout', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': '1'
    }
  }).catch(err => logger.error('Desync logout API call failed: %o', err));

  // Dispatch event so React Query invalidates user state
  window.dispatchEvent(new CustomEvent('auth-storage-desync'));
}

export function handleError<T>(error: unknown, ctx?: { method: string; params: T }, toastOptions?: Toast) {
  // User-cancelled operations (dismissed password dialog) — silently ignore
  if (isUserCancelled(error)) {
    logger.info('User cancelled operation in %s — no toast', ctx?.method);
    return;
  }

  // Auth storage desync: IndexedDB cleared but session cookie remains.
  // Auto-logout and show friendly message instead of cryptic error.
  if (isAuthStorageDesync(error)) {
    logger.warn('Auth storage desync detected in %s — triggering auto-logout', ctx?.method);
    performDesyncLogout();
    toast({
      description: 'Your secure key storage was cleared by your browser. Please sign in again.',
      variant: 'default',
      ...toastOptions
    });
    return;
  }

  const { errorTitle, fullError, isWellKnownError } = transformError<T>(error, ctx);

  if (!!env('SENTRY_DSN') && !isWellKnownError)
    Sentry.captureException(fullError);

  toast({
    description: (
      <ErrorToastContent errorTitle={errorTitle} fullError={fullError} displayControls={!isWellKnownError} />
    ),
    variant: 'destructive',
    ...toastOptions
  });
}
