import { cookies } from 'next/headers';
import { getIronSession } from 'iron-session';
import { sessionOptions } from '@smart-signer/lib/session';
import { applyHiveSessionTtl } from '@smart-signer/lib/get-session';
import type { IronSessionData } from '@smart-signer/types/common';
import { getLogger } from '@ui/lib/logging';

const logger = getLogger('app');

export interface ServerSessionUser {
  isLoggedIn: boolean;
  username: string;
}

const SIGNED_OUT: ServerSessionUser = { isLoggedIn: false, username: '' };

/**
 * Who the session cookie says this request is, read on the server.
 *
 * `app/profile/page.tsx` did this inline to decide where to redirect a signed-out
 * reader. Two more places need the same answer now — the auth gate on `/wallet`,
 * and the root layout, which hands it to the header and the left rail so they stop
 * drawing a signed-out product for a signed-in reader (see
 * `features/layouts/server-session.tsx`) — so it lives in one place with one
 * failure behaviour rather than three copies that can drift.
 *
 * A cookie that will not open is "signed out", never an error page: a stale or
 * malformed cookie is the normal state of a returning visitor whose session
 * secret rotated, and a 500 there would lock them out of the whole site.
 */
export async function getServerSessionUser(): Promise<ServerSessionUser> {
  try {
    const session = await getIronSession<IronSessionData>(cookies(), sessionOptions);
    // A sealed cookie no longer carries its own expiry (J6's `maxAge: undefined`
    // forces iron-session's seal `ttl` to 0), so expiry is enforced in
    // application code or not at all. This reader gates real redirects for
    // `/wallet`, `/wallet/tokens`, `/creators/launch`, `/creators/studio` and
    // `/profile`, and tells the header and left rail whether to draw a
    // signed-in product — so without this call a 400-day-old cookie still
    // opened all of them. `canPersist: false` because this runs inside a Server
    // Component render, where Next.js forbids writing cookies.
    await applyHiveSessionTtl(session, { canPersist: false });
    if (session.user?.isLoggedIn && session.user.username) {
      return { isLoggedIn: true, username: session.user.username };
    }
  } catch (error) {
    logger.warn('server-session: could not read the session cookie, treating as signed out: %o', error);
  }
  return SIGNED_OUT;
}

/**
 * Where to send a signed-out reader who asked for a page that needs an account,
 * carrying the page they wanted so signing in returns them to it instead of
 * dumping them on the feed. `lumen-login.tsx` is what honours the parameter.
 */
export function loginRedirectFor(destination: string): string {
  return `/login?next=${encodeURIComponent(destination)}`;
}
