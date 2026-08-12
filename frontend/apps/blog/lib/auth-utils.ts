import { cache } from 'react';
import { cookies } from 'next/headers';
import { getIronSession } from 'iron-session';
import { sessionOptions } from '@smart-signer/lib/session';
import { applyHiveSessionTtl } from '@smart-signer/lib/get-session';
import type { IronSessionData } from '@smart-signer/types/common';
import { DEFAULT_OBSERVER } from './utils';
import { getLogger } from '@ui/lib/logging';

const logger = getLogger('app');

/**
 * Returns the observer username for SSR personalization.
 * This is an untrusted display hint — not an authentication check.
 *
 * Check order:
 * 1. observer cookie (lightweight, client-set on login)
 * 2. iron-session fallback (edge case: observer cookie missing but authenticated)
 * 3. DEFAULT_OBSERVER ('hive.blog')
 *
 * Wrapped with React.cache() to deduplicate across RSC calls within a request.
 */
export const getObserver = cache(async (): Promise<string> => {
  const cookieStore = cookies();

  // Primary: observer cookie (lightweight, client-set)
  const observerCookie = cookieStore.get('observer');
  if (observerCookie?.value) {
    const observer = observerCookie.value;
    if (/^[a-z0-9.-]{1,16}$/.test(observer)) {
      return observer;
    }
  }

  // Fallback: iron-session (edge case — observer cookie missing but user authenticated)
  try {
    const session = await getIronSession<IronSessionData>(cookieStore, sessionOptions);
    // F-L40 (2026-08-12): a sealed Hive session cookie carries no expiry of its
    // own (see get-session.ts's doc comment) — without this call a 400-day-old
    // cookie kept reading as signed in here, and this function's whole job is
    // personalising the bridge read (`observer`) for the visitor, so an expired
    // session was silently shaping what the chain returned for them. This is
    // the more serious of the two gaps closed today for exactly that reason.
    // `canPersist: false`: this runs inside a `cache()`-wrapped Server
    // Component read, where Next.js forbids writing cookies.
    await applyHiveSessionTtl(session, { canPersist: false });
    // A lite account's display_name is NOT a real Hive account, so it must never
    // be used as a bridge `observer` (would silently corrupt personalization).
    // Spec §A.5 (must-fix).
    if (session.user?.username && session.user.account_tier !== 'lite') {
      return session.user.username;
    }
  } catch (error) {
    logger.error(error, 'Error reading iron-session in getObserver:');
  }

  return DEFAULT_OBSERVER;
});

// Backward-compatible alias — will be removed after all call sites update
export const getObserverFromCookies = getObserver;
