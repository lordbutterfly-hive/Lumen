import { PostLoginSchema } from '@smart-signer/lib/auth/utils';
import { User } from '@smart-signer/types/common';
import { getLogger } from '@ui/lib/logging';

const logger = getLogger('app');

/**
 * Create a User object from validated login data.
 * Note: Cryptographic signature verification is performed in the login
 * handler (login.ts) before this function is called.
 *
 * @param {PostLoginSchema} data
 * @returns {Promise<User>}
 */
export async function verifyLogin(data: PostLoginSchema): Promise<User> {
  const { username, keyType, strict, loginType } = data;
  // F-L13 — this logged the ENTIRE payload at info. postLoginSchema carries
  // `hivesignerToken` (a live bearer credential), `signatures.posting`,
  // `signatures.active` and `txJSON`, so every login wrote replayable
  // authentication material into the app log. The Sentry scrubber does not
  // cover this path — it is wired to Sentry only, and pino has no redaction
  // configured — so nothing downstream was removing them either.
  // Log the identifying fields, which is all the diagnostics ever needed.
  logger.info('verifyLogin argument data: %o', { username, keyType, strict, loginType });

  try {
    // Create User object from login data
    const user: User = {
      isLoggedIn: true,
      username,
      avatarUrl: '',
      loginType,
      keyType,
      authenticateOnBackend: false,
      chatAuthToken: '',
      oauthConsent: {},
      strict
    };
    return user;
  } catch (error) {
    logger.error(error, 'Error in verifyLogin');
    throw error;
  }
}
