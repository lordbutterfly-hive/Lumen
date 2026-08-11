import { redirect } from 'next/navigation';
import { getServerSessionUser, loginRedirectFor } from '@/blog/lib/server-session';

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
  // Reading the cookie (and treating a malformed one as signed out rather than as
  // an error page) is now shared with /wallet and the root layout.
  const session = await getServerSessionUser();
  redirect(session.isLoggedIn ? `/@${session.username}` : loginRedirectFor('/profile'));
}
