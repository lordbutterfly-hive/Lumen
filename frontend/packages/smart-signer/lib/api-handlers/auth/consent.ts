import createHttpError from 'http-errors';
import { NextApiHandler } from 'next';
import { getIronSession } from 'iron-session';
import { sessionOptions } from '@smart-signer/lib/session';
import { User } from '@smart-signer/types/common';
import { IronSessionData } from '@smart-signer/types/common';
import { checkCsrfHeader } from '@smart-signer/lib/csrf-protection';
import { getLogger } from '@hive/ui/lib/logging';
import { postConsentSchema, PostConsentSchema } from '@smart-signer/lib/auth/utils';

const logger = getLogger('app');


/**
 * Register in session user consent in Oauth flow.
 *
 * @param {*} req
 * @param {*} res
 */
export const registerConsent: NextApiHandler<User> = async (req, res) => {
  checkCsrfHeader(req);

  let user: User | undefined;
  try {
    const session = await getIronSession<IronSessionData>(
      req, res, sessionOptions
    );
    user = session.user;
  } catch (error) {
    logger.error(error, 'registerConsent error');
  }

  if (!(user?.isLoggedIn && user.username)) {
    throw new createHttpError.Unauthorized();
  }

  // ★★★ OAUTH CONSENT REQUIRES A BACKEND-VERIFIED IDENTITY.
  //
  // This endpoint records "yes, let this client act as me" — the whole point of
  // which is asserting a VERIFIED Hive identity to a relying party. Its sibling
  // `/api/oauth/authorize` refuses a caller without `authenticateOnBackend`
  // (lib/oauth/handlers.ts), and `buildLiteSessionUser` hardcodes that to false
  // for every lite session, because a Lumen handle is not a chain account and
  // nothing here has proved possession of its keys.
  //
  // This route never learned lite sessions exist: it checked only
  // isLoggedIn + username, both true for a lite session, and wrote the consent.
  // Found by an API probe 2026-08-07 — a seam between two auth generations,
  // invisible from the UI because no Lumen screen links here.
  if (!user.authenticateOnBackend) {
    logger.warn(
      'registerConsent: refusing consent for %s — session is not backend-authenticated (tier %s)',
      user.username,
      user.account_tier ?? 'unknown'
    );
    throw new createHttpError.Forbidden('This account cannot grant OAuth consent.');
  }

  const data: PostConsentSchema = await postConsentSchema.parseAsync(req.body);
  user.oauthConsent[data.oauthClientId] = data.consent;

  const session = await getIronSession<IronSessionData>(req, res, sessionOptions);
  session.user = user;
  await session.save();
  res.json(user);
};
