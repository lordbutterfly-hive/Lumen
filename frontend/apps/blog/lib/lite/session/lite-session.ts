import { KeyType, LoginType, User } from '@smart-signer/types/common';
import { LumenUser } from '../types';

/**
 * Session glue for lite accounts.
 *
 * Design (spec §A.5, adjudicated): we keep the existing FLAT `User` session shape
 * and only add `userId` + `account_tier`, with `username = display_name`. Lite
 * users are kept entirely off the `LoginType`/`getSigner()` axis — their real auth
 * method lives in `lumen_auth_credential.method`, never as a `LoginType`.
 */

/**
 * Placeholder `loginType` for a lite session. It is NEVER consulted: every signer
 * path gates on `account_tier === 'lite'` first (see SignerProvider). We pick a
 * value that maps to a key-requiring signer so that any *unguarded* getSigner call
 * fails closed (prompts/throws) rather than silently mis-signing. Do not read this
 * field for lite users — use `isLiteUser()` / `account_tier` instead.
 */
const LITE_PLACEHOLDER_LOGIN_TYPE = LoginType.wif;

export function isLiteUser(user?: Pick<User, 'account_tier'> | null): boolean {
  return user?.account_tier === 'lite';
}

/** Build the iron-session `User` payload for a lite account. */
export function buildLiteSessionUser(u: LumenUser): User {
  return {
    isLoggedIn: true,
    username: u.displayName, // the /@{display_name} handle (§E.2)
    userId: u.userId, // permanent; survives the ACT upgrade (§3)
    account_tier: u.accountTier, // 'lite' -> off the getSigner axis (§A.5)
    avatarUrl: u.avatarUrl ?? '',
    loginType: LITE_PLACEHOLDER_LOGIN_TYPE,
    keyType: KeyType.posting,
    authenticateOnBackend: false,
    chatAuthToken: '',
    oauthConsent: {},
    strict: false
  };
}
