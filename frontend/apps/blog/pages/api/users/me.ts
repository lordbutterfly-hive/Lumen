import type { NextApiRequest, NextApiResponse } from 'next';
import { getIronSession } from 'iron-session';
import { apiHandler } from '@smart-signer/lib/api';
import { getUser } from '@smart-signer/lib/api-handlers/users/me';
import { sessionOptions } from '@smart-signer/lib/session';
import { defaultUser } from '@smart-signer/lib/auth/utils';
import type { IronSessionData, User } from '@smart-signer/types/common';
import { findUserById } from '@/blog/lib/lite/repositories/user-repository';
import { getLogger } from '@hive/ui/lib/logging';

const logger = getLogger('app');

/**
 * Who does the app think you are?
 *
 * ★ THIS ENDPOINT MUST HONOUR LOGOUT (2026-08-07). It did not, and that made the
 * session-revocation work already shipped for the write routes only half true.
 *
 * `logout` bumps the user's `session_epoch` in the database — deliberately
 * signing out every device, because there is no per-session id. Every lite WRITE
 * route compares the cookie's stamped epoch against that row and refuses on a
 * mismatch (`requireLiteUser` / `checkLiteActorById`). The shared `getUser`
 * handler never learned about any of it: it checks `session.user` and nothing
 * else, so a cookie that logout had just revoked kept answering
 * `{isLoggedIn: true, username: …}` forever.
 *
 * Consequences found live: after logging out, the app kept presenting the old
 * identity — through in-app navigation, through window focus, through a 12-second
 * wait, and through a HARD RELOAD, because the reload re-asked this endpoint and
 * this endpoint kept saying yes. One screen went further and rendered a specific
 * false claim about the dead session's wallet.
 *
 * The epoch check lives HERE rather than in the shared handler on purpose: the
 * user row and the epoch are app-level (Lumen lite) concepts, and
 * packages/smart-signer must not reach up into apps/blog to read them.
 *
 * Fails OPEN on a lookup error, deliberately: this endpoint gates what the UI
 * displays, not what the server permits. Every write path does its own check, so
 * a database blip here must not log the whole site out.
 */
const getUserWithRevocationCheck = async (req: NextApiRequest, res: NextApiResponse<User>) => {
  const session = await getIronSession<IronSessionData>(req, res, sessionOptions);
  const sessionUser = session.user;

  // Only lite sessions carry a revocable epoch. A Hive-keyed login is
  // authenticated by a signed challenge and has no Lumen row to compare against.
  if (sessionUser?.isLoggedIn && sessionUser.account_tier === 'lite' && sessionUser.userId) {
    try {
      const row = await findUserById(sessionUser.userId);
      const revoked =
        !row ||
        (session.sessionEpoch !== undefined && row.sessionEpoch !== session.sessionEpoch);
      if (revoked) {
        res.json(defaultUser);
        return;
      }
    } catch (error) {
      logger.error(error, 'users/me: session revocation check failed; serving the session as-is');
    }
  }

  return getUser(req, res);
};

export default apiHandler({
  GET: getUserWithRevocationCheck
});
