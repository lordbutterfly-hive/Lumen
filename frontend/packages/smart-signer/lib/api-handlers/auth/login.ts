import createHttpError from 'http-errors';
import { NextApiHandler } from 'next';
import { getAppSession } from '@smart-signer/lib/get-session';
import { getAccount } from '@transaction/lib/hive-api';
import { getChain } from '@transaction/lib/chain';
import { postLoginSchema, PostLoginSchema } from '@smart-signer/lib/auth/login-schema';
import { User } from '@smart-signer/types/common';
import { cookieNamePrefix } from '@smart-signer/lib/session';
import { checkCsrfHeader } from '@smart-signer/lib/csrf-protection';
import { verifyLoginChallenge } from '@smart-signer/lib/verify-login-challenge';
import { verifyLogin } from '@smart-signer/lib/verify-login';
import { getLoginChallengeFromTransactionForLogin } from '@smart-signer/lib/login-operation';
import { getLogger } from '@hive/ui/lib/logging';
import { siteConfig } from '@hive/ui/config/site';
import { getChatAuthToken } from '@smart-signer/lib/rocket-chat';
import { logLoginEvent, getClientIpFromApiRequest } from '@smart-signer/lib/event-logging';
import { isHiveNetworkError, withHiveRetry } from '@smart-signer/lib/hive-network-error';

/**
 * ★ "COULD NOT REACH HIVE" IS NOT "YOUR SIGN-IN FAILED" (2026-08-09).
 *
 * Sign-in verifies the signature against the chain, so this handler cannot work
 * when the node is unreachable — but the reader must be told WHICH of those
 * happened. `apiHandler`'s fallback turns any unrecognised throw into a flat
 * 500 `Internal Server Error`, so a transient connect stall reached the login
 * screen as "That sign-in did not complete", which reads as "your credentials
 * are wrong" and invites the reader to retype something that was never wrong.
 *
 * 503 is the honest code, and `expose: true` is load-bearing: `createHttpError`
 * defaults `expose` to FALSE for every 5xx, and the error handler only forwards
 * the message when `expose` is set — without it this would be a 500 again with
 * the text stripped.
 */
function unreachableChainError(error: unknown) {
  logger.error(error, 'login: Hive node unreachable while verifying sign-in');
  return createHttpError(
    503,
    'Could not reach Hive to verify your sign-in. This is a problem on our side, not with your account — please try again in a moment.',
    { expose: true }
  );
}

const logger = getLogger('app');

export const loginUser: NextApiHandler<User> = async (req, res) => {
  checkCsrfHeader(req);

  const loginChallenge = req.cookies[`${cookieNamePrefix}login_challenge_server`] || '';

  const data: PostLoginSchema = await postLoginSchema.parseAsync(req.body);

  const { username, loginType, signatures, keyType, authenticateOnBackend, strict } = data;
  let hiveUserProfile;
  let chainAccount;
  try {
    chainAccount = await withHiveRetry(() => getAccount(username), 'login getAccount');
    if (!chainAccount) {
      throw new Error(`Missing blockchain account "${username}"`);
    }
    hiveUserProfile = chainAccount?.profile;
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.startsWith('Missing blockchain account')) {
        throw new createHttpError.NotFound(`Hive user ${username} not found`);
      }
    }
    // A node we could not reach told us nothing about this account. Saying
    // "user not found" here would be a lie with real consequences.
    if (isHiveNetworkError(error)) throw unreachableChainError(error);
    throw error;
  }

  let result: boolean = false;
  let verifiedUser: User | undefined;

  if (JSON.parse(data.txJSON)) {
    const parsedTx = JSON.parse(data.txJSON);

    // Check whether loginChallenge is correct.
    const reguestLoginChallenge = getLoginChallengeFromTransactionForLogin(parsedTx, keyType);
    if (reguestLoginChallenge !== loginChallenge) {
      throw new createHttpError[401]('Invalid login challenge');
    }

    // Verify that the claimed username matches the account in the transaction.
    const txOp = parsedTx.operations[0];
    const txAuthAccount = keyType === 'posting'
      ? txOp?.value?.required_posting_auths?.[0]
      : txOp?.value?.required_auths?.[0];
    if (txAuthAccount !== username) {
      throw new createHttpError.Unauthorized('Username does not match transaction authority');
    }

    // Verify signature — proves the client possesses the private key.
    try {
      await withHiveRetry(async () => {
        const chain = await getChain();
        return chain.api.database_api.verify_authority({
          trx: parsedTx,
          pack: data.pack
        });
      }, 'login verify_authority');
    } catch (verifyError) {
      // ★ An unreachable node did NOT reject this signature. Reporting 401
      // here accuses the reader of a bad credential on the strength of a
      // network failure — the single most misleading thing this handler could
      // say, and what it used to say.
      if (isHiveNetworkError(verifyError)) throw unreachableChainError(verifyError);
      logger.error(verifyError, 'Signature verification failed for user %s', username);
      throw new createHttpError.Unauthorized('Signature verification failed');
    }

    // Create User object from verified login data.
    try {
      verifiedUser = await verifyLogin(data);
      result = verifiedUser.isLoggedIn;
    } catch (error) {
      logger.error(error, 'Failed to create user object for %s', username);
    }
  } else {
    result = await verifyLoginChallenge(chainAccount, signatures, JSON.stringify({ loginChallenge }));
  }

  if (!result) {
    throw new createHttpError.Unauthorized('Invalid username or password');
  }

  let chatAuthToken = '';
  const oauthConsent: { [key: string]: boolean } = {};
  logger.info('Chat integration check: iframeEnable=%s, strict=%s, allowNonStrict=%s',
    siteConfig.openhiveChatIframeIntegrationEnable,
    verifiedUser?.strict,
    siteConfig.openhiveChatAllowNonStrictLogin
  );
  if (
    siteConfig.openhiveChatIframeIntegrationEnable &&
    (verifiedUser?.strict || siteConfig.openhiveChatAllowNonStrictLogin)
  ) {
    const result = await getChatAuthToken(username);
    logger.info('getChatAuthToken result: success=%s, hasToken=%s', result.success, !!result.data?.authToken);
    if (result.success) {
      chatAuthToken = result.data.authToken;
      oauthConsent[siteConfig.openhiveChatClientId] = true;
    }
  }

  const user: User = {
    isLoggedIn: true,
    username,
    avatarUrl: hiveUserProfile?.profile_image || '',
    loginType,
    keyType,
    authenticateOnBackend,
    chatAuthToken,
    oauthConsent,
    strict: verifiedUser?.strict ? true : false
  };
  const session = await getAppSession(req, res);
  session.user = user;
  // F-L39 (2026-08-12): stamp the Hive TTL clock AT ISSUE, here, rather than
  // relying solely on `getAppSession()`'s read-side backfill. This is the
  // ACTUAL issuance point for every full-Hive session (the OAuth/consent/
  // chat-token handlers only ever read one login.ts already created) — the
  // "real, stated gap" F-L38 left open (see the long comment on
  // `hiveSessionIssuedAt` in packages/smart-signer/types/common.ts: "a Hive
  // user whose browsing never reaches a route that calls getLiteSession()
  // never gets backfilled"). Stamping here means that gap no longer exists
  // for any session created from this point forward; the read-side backfill
  // remains only for the backlog of sessions issued before this change.
  session.hiveSessionIssuedAt = Date.now();
  await session.save();

  // Set account_info cookie for page visit logging in Edge Runtime middleware.
  // This mirrors the verified identity from iron-session in a format readable
  // without decryption. Set after verify_authority + session.save() so the
  // values are trustworthy. Session cookie (no Max-Age) to match iron-session.
  const securePart = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const existing = res.getHeader('Set-Cookie') || [];
  const cookies = Array.isArray(existing) ? existing : [String(existing)];
  cookies.push(`account_info=${username}:${loginType}; Path=/; HttpOnly; SameSite=Lax${securePart}`);
  res.setHeader('Set-Cookie', cookies);

  // Log login event atomically with session creation
  const uid = req.cookies['session_uid'] || 'n/a';
  logLoginEvent(getClientIpFromApiRequest(req), username, loginType, uid);

  res.json(user);
};
