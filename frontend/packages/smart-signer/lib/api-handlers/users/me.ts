import { NextApiHandler } from "next";
import { getIronSession } from 'iron-session';
import { sessionOptions, cookieNamePrefix } from '@smart-signer/lib/session';
import { defaultUser } from '@smart-signer/lib/auth/utils';
import { User } from '@smart-signer/types/common';
import { IronSessionData } from '@smart-signer/types/common';
import { getLogger } from "@hive/ui/lib/logging";

const logger = getLogger('app');

/**
 * ★★★ AN UNREADABLE SESSION COOKIE IS NOT THE SAME AS NO SESSION COOKIE
 * (2026-08-09). This handler is the single authority the client asks "am I
 * signed in?" — `useUserCore` refetches it on EVERY mount — so whatever it says
 * is what the header renders and what `/api/feed/for-you` personalises against.
 *
 * It used to answer `defaultUser` for two completely different situations:
 *   (a) the browser sent no session cookie      — genuinely signed out;
 *   (b) the browser sent one and it did not open — the seal did not verify.
 *
 * (b) happens whenever the server is running with a DIFFERENT
 * `DENSER_SERVER_SECRET_COOKIE_PASSWORD` than the one that sealed the cookie,
 * because that value IS the encryption key. Proven on this box: one payload
 * sealed with `apps/blog/.env.local`'s secret returns
 * `isLoggedIn:true username:"lordbutterfly"`, and the SAME payload sealed with
 * `.env.blog`'s secret returns `isLoggedIn:false` — silently, with no error
 * anywhere, indistinguishable from never having logged in.
 *
 * That silence is the whole defect. The owner reported being "consistently
 * logged out on refresh and going back to home", and the feed serving the
 * anonymous list (`source: trending-fallback, degraded: anonymous`) was the same
 * bug wearing a different hat — the route saw no viewer, so it correctly served
 * trending. Two QA agents independently hit it the same day and could only
 * diagnose it by hashing `/proc/<pid>/environ`. Nothing in the app said a word.
 *
 * No test caught it because every test signs in and asserts within ONE server
 * lifetime under ONE env file; reproducing it requires a cookie to OUTLIVE an
 * env change. So the fix is not a test, it is refusing to be silent: when a
 * cookie is present but yields no user, say so, loudly, once per request. The
 * ANSWER is unchanged — an unreadable cookie must still mean signed-out, and
 * must never be trusted — but now it is diagnosable in one log line instead of
 * a two-hour investigation.
 */
export const getUser: NextApiHandler<User> = async (req, res) => {
  const session = await getIronSession<IronSessionData>(req, res, sessionOptions);
  if (session.user) {
    res.json({
      ...session.user,
      isLoggedIn: true,
    });
    return;
  }

  // Read the raw cookie rather than anything iron-session derived: we are
  // asking "did the browser send one", not "did it open".
  const sessionCookieName = `${cookieNamePrefix}session`;
  const hadCookie = Boolean(req.cookies?.[sessionCookieName]);
  if (hadCookie) {
    logger.warn(
      'users/me: a %s cookie WAS sent but did not yield a session — treating as signed out. ' +
        'This is almost always DENSER_SERVER_SECRET_COOKIE_PASSWORD differing from the value ' +
        'that sealed the cookie (check every env file the server can be started with), or a ' +
        'cookie older than iron-session\'s ttl. The reader sees an unexplained logout.',
      sessionCookieName
    );
  }
  res.json(defaultUser);
};
