import { getCookie } from '@ui/lib/utils';
import { cookieNamePrefix } from './session';

/**
 * ★ THE LOGIN CHALLENGE MAY NOT EXIST YET (2026-09-02, snappiness phase 2).
 * Anonymous pages a shared cache may hold no longer mint the challenge cookie
 * pair on the page response (a stored Set-Cookie would be replayed to other
 * visitors); the first API call of the visit mints them instead, and every
 * page makes one (`/api/users/me`) right after hydration. A reader who reaches
 * the sign-in step before that call has finished would sign an empty
 * challenge, so this asks for it explicitly and re-reads the cookie.
 */
export async function ensureLoginChallenge(): Promise<string> {
  const name = `${cookieNamePrefix}login_challenge`;
  const present = getCookie(name);
  if (present) return present;
  try {
    await fetch('/api/users/me', { credentials: 'include', cache: 'no-store' });
  } catch {
    // Offline or blocked: the caller falls back to the empty challenge and the
    // server rejects the login as it always did.
  }
  return getCookie(name) || '';
}
