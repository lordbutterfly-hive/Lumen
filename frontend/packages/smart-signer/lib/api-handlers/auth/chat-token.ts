import createHttpError from 'http-errors';
import { NextApiHandler } from 'next';
import { getAppSession } from '@smart-signer/lib/get-session';
import { User } from '@smart-signer/types/common';
import { checkCsrfHeader } from '@smart-signer/lib/csrf-protection';
import { getLogger } from '@hive/ui/lib/logging';
import { siteConfig } from '@hive/ui/config/site';
import { getChatAuthToken } from '@smart-signer/lib/rocket-chat';

const logger = getLogger('app');

/**
 * Create a new auth token in Rocket Chat and return it in User object.
 *
 * @param {*} req
 * @param {*} res
 */
export const getChatToken: NextApiHandler<User> = async (req, res) => {
  checkCsrfHeader(req);

  let user: User | undefined;
  try {
    // F-L39 (2026-08-12): see the identical comment in consent.ts —
    // `getAppSession()` replaces a bare `getIronSession(req, res,
    // sessionOptions)` here for the same reason: this handler mints a real
    // Rocket.Chat auth token, and an expired-but-sealed cookie used to pass
    // the `isLoggedIn` check below just as well as a fresh one.
    const session = await getAppSession(req, res);
    user = session.user;
  } catch (error) {
    logger.error(error, 'getChatToken error');
  }

  if (!(
    user?.isLoggedIn
    && (user.strict || siteConfig.openhiveChatAllowNonStrictLogin)
    && user.oauthConsent?.[siteConfig.openhiveChatClientId]
  )) {
    throw new createHttpError.Unauthorized();
  }


  let chatAuthToken = '';
  if (siteConfig.openhiveChatIframeIntegrationEnable) {
    const result = await getChatAuthToken(user.username);
    if (result.success) {
      chatAuthToken = result.data.authToken;
    }
  }

  user = {
    ...user,
    chatAuthToken,
  };
  const session = await getAppSession(req, res);
  session.user = user;
  await session.save();
  res.json(user);
};
