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
import { unsealLoginChallenge } from '@smart-signer/lib/challenge-seal';
import { getLogger } from '@hive/ui/lib/logging';
import { siteConfig } from '@hive/ui/config/site';
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

  // SMS-01 (2026-09-08): the "server half" of the challenge is now a SEALED
  // value (see lib/challenge-seal.ts and the middleware that mints it). Reading
  // it raw made it caller-forgeable — a non-browser client supplied BOTH sides
  // of the comparison below, so it gated nothing. Unseal it here; a bad, forged,
  // tampered or absent seal yields '', which the challenge comparison then
  // rejects (a real challenge is always truthy).
  const loginChallenge = await unsealLoginChallenge(
    req.cookies[`${cookieNamePrefix}login_challenge_server`] || ''
  );

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

    // SMS-01 (2026-09-08): bind the proof to a single, current, Lumen login op.
    // Nothing here used to read `expiration`, the operation count, or the op
    // `id`, so ANY validly-signed custom_json carrying a truthy `challenge` —
    // one expired years ago, or one already public on chain for an unrelated
    // app — authenticated, forever. Re-establish the three properties the
    // legitimate client already builds into every login (see
    // lib/login-operation.ts `getOperationForLogin` and
    // components/auth/process.tsx).

    // (a) Exactly one operation. A login proof is a single custom_json; extra
    //     operations were never inspected and have no business on this path.
    if (!Array.isArray(parsedTx.operations) || parsedTx.operations.length !== 1) {
      throw new createHttpError[401]('Invalid login transaction');
    }

    // (b) The operation must be THIS app's login op for the declared login type
    //     (`denser_${loginType}`), exactly as `getOperationForLogin` mints it —
    //     which covers every LoginType (keychain/wif/hbauth/hiveauth/peakvault/
    //     metamask/google/hivesigner). This refuses an arbitrary custom_json id
    //     reused as a keyless login proof.
    if (parsedTx.operations[0]?.value?.id !== `denser_${loginType}`) {
      throw new createHttpError[401]('Invalid login transaction');
    }

    // (c) Freshness. Refuse a transaction whose `expiration` has passed (this is
    //     what turned the proof from a one-shot into a permanent bearer
    //     credential), and refuse one dated implausibly far into the future.
    //     Hive expirations are absolute UTC with no offset suffix, so parsing is
    //     forced to UTC. The legitimate client sets expiration = now + 1h
    //     (process.tsx), so a live login sits comfortably inside the window
    //     while a stale or replayed proof does not. Compared to server wall
    //     time, which tracks head-block time within NTP skew for an absolute
    //     UTC timestamp — no extra chain round-trip on the login path.
    const rawFuture = Number(process.env.LOGIN_TX_MAX_FUTURE_SECONDS);
    const maxFutureMs = (Number.isFinite(rawFuture) && rawFuture > 0 ? rawFuture : 3900) * 1000;
    const expirationRaw = String(parsedTx.expiration ?? '');
    const expirationMs = Date.parse(
      /([zZ]|[+-]\d\d:?\d\d)$/.test(expirationRaw) ? expirationRaw : `${expirationRaw}Z`
    );
    const now = Date.now();
    if (!Number.isFinite(expirationMs) || expirationMs <= now || expirationMs > now + maxFutureMs) {
      throw new createHttpError[401]('Login transaction has expired');
    }

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

  const user: User = {
    isLoggedIn: true,
    username,
    avatarUrl: hiveUserProfile?.profile_image || '',
    loginType,
    keyType,
    authenticateOnBackend,
    strict: verifiedUser?.strict ? true : false
  };
  const session = await getAppSession(req, res);
  session.user = user;
  // F-L39 (2026-08-12): stamp the Hive TTL clock AT ISSUE, here, rather than
  // relying solely on `getAppSession()`'s read-side backfill. This is the
  // ACTUAL issuance point for every full-Hive session — and, since the
  // Rocket.Chat/OAuth-consent handlers were removed (2026-08-23), the ONLY
  // one; nothing else creates a full-Hive session — the
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
