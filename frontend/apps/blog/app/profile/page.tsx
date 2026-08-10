import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getIronSession } from 'iron-session';
import { sessionOptions } from '@smart-signer/lib/session';
import type { IronSessionData } from '@smart-signer/types/common';
import { getLogger } from '@ui/lib/logging';

const logger = getLogger('app');

/**
 * `/profile` did not exist, so the sidebar's own Profile link 404'd for a signed-out
 * reader and the fuckery list recorded it as "redirects to /login with no explanation
 * and no return destination" (v8, section 5).
 *
 * It is a pure redirect, and the only interesting part is WHERE to.
 *
 *  * Signed in: there is no such thing as "the profile page" in this app, a profile
 *    lives at `/@name`. Send them to their own.
 *  * Signed out: `/login`, carrying `?next=/profile` so the login screen can return
 *    them here afterwards rather than dumping them on the feed, which is what the
 *    list was complaining about.
 *
 * Server-side on the session cookie, so there is no flash of the wrong destination.
 */
export default async function ProfileIndexPage() {
  let username: string | undefined;
  try {
    const session = await getIronSession<IronSessionData>(cookies(), sessionOptions);
    if (session.user?.isLoggedIn) username = session.user.username;
  } catch (error) {
    // A malformed cookie means "not signed in" here, never an error page.
    logger.warn('profile: could not read session, treating as signed out: %o', error);
  }

  redirect(username ? `/@${username}` : '/login?next=/profile');
}
