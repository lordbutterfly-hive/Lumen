import { NextApiHandler } from "next";
import { getIronSession } from 'iron-session';
import { sessionOptions, cookieNamePrefix } from '@smart-signer/lib/session';
import { defaultUser } from '@smart-signer/lib/auth/utils';
import { User } from '@smart-signer/types/common';
import { IronSessionData } from '@smart-signer/types/common';
import { getLogger } from "@hive/ui/lib/logging";

const logger = getLogger('app');

/**
 * ★ AN UNREADABLE SESSION COOKIE IS NOT THE SAME AS NO SESSION COOKIE.
 *
 * Both must answer "signed out" — a cookie that will not open can never be
 * trusted — but only one of them is a misconfiguration, so it gets a log line.
 * It happens when the server runs with a different
 * `DENSER_SERVER_SECRET_COOKIE_PASSWORD` than the one that sealed the cookie,
 * since that value IS the encryption key.
 *
 * Kept for diagnosis, not as an explanation: the "logged out on refresh" report
 * this was written for turned out to be something else entirely — login never
 * created a session at all (see `lite-auth/login/keychain-signin.tsx`).
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
