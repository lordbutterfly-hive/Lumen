import { NextApiHandler } from 'next';
import { getAppSession } from '@smart-signer/lib/get-session';
import { defaultUser } from '@smart-signer/lib/auth/utils';
import { User } from '@smart-signer/types/common';
import { checkCsrfHeader } from '@smart-signer/lib/csrf-protection';
import { getLogger } from '@ui/lib/logging';
import { oidc } from '@smart-signer/lib/oidc';
import { logLogoutEvent, getClientIpFromApiRequest } from '@smart-signer/lib/event-logging';

const logger = getLogger('app');

export const logoutUser: NextApiHandler<User> = async (req, res) => {
  checkCsrfHeader(req);

  if (oidc) {
    try {
      // Destroy oidc session
      const ctx = oidc.app.createContext(req, res);
      const oidcSession = await oidc.Session.get(ctx);
      if (oidcSession?.accountId) {
        logger.info('Logout: destroying oidc session for user: %s',
            oidcSession?.accountId);
        await oidcSession.destroy();
      }
    } catch (error) {
      logger.error('Logout: error when destroying oidc session: %s', error instanceof Error ? error.message : String(error));
    }
  }

  try {
    // Destroy app session. F-L39 (2026-08-12): routed through `getAppSession()`
    // like every other call site in this package, for consistency — logout
    // has no auth DECISION riding on session freshness (it unconditionally
    // destroys whatever is here), but going through the shared accessor
    // means an already-stale session logs itself out as "unknown" rather
    // than attributing the destroy to a username `getAppSession()` has
    // already blanked, and keeps this file from being the one straggler
    // that still calls `getIronSession(req, res, sessionOptions)` raw.
    const session = await getAppSession(req, res);
    if (session) {
      // Log logout event BEFORE destroying session (need user data for log)
      const username = session.user?.username || 'unknown';
      const loginType = session.user?.loginType || 'unknown';
      const uid = req.cookies['session_uid'] || 'n/a';
      logLogoutEvent(getClientIpFromApiRequest(req), username, loginType, uid);

      logger.info('Logout: destroying app session for user: %s', username);
      session.destroy();
    }
  } catch (error) {
    logger.error('Logout: error when destroying app session: %s', error instanceof Error ? error.message : String(error));
  }

  // Clear account_info cookie (mirrors iron-session destruction)
  const securePart = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const existing = res.getHeader('Set-Cookie') || [];
  const cookies = Array.isArray(existing) ? existing : [String(existing)];
  cookies.push(`account_info=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${securePart}`);
  res.setHeader('Set-Cookie', cookies);

  res.json(defaultUser);
};
