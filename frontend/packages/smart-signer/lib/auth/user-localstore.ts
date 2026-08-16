import { User } from '@smart-signer/types/common';
import { defaultUser } from '@smart-signer/lib/auth/utils';
import { isStorageAvailable } from '@smart-signer/lib/utils';
import { safeJsonParse } from '@smart-signer/lib/safe-json-parse';

const USER_LOCAL_STORAGE_KEY = 'user';

export function saveUser(user: User): void {
  if (isStorageAvailable('localStorage')) {
    // M13: `chatAuthToken` (OpenHive Chat / Rocket.Chat SSO bearer token, set in
    // api-handlers/auth/login.ts and api-handlers/auth/chat-token.ts) is a secret,
    // unlike every other field on `User`, and plain localStorage is readable by
    // any script an XSS bug lets run — first-party or not. The iframe SSO flow
    // that actually needs this token never goes through this object at all:
    // api-handlers/chat/sso.ts reads it straight out of the (httpOnly) session
    // cookie on request and hands it to the Rocket.Chat iframe server-side, so
    // nothing in the browser needs a JS-readable copy. Blanked here rather than
    // omitted, so the persisted shape still matches `User` (`chatAuthToken:
    // string`) for whatever reads this key back. The in-memory/React Query copy
    // is untouched — only the on-disk copy is scrubbed.
    localStorage.setItem(USER_LOCAL_STORAGE_KEY, JSON.stringify({ ...user, chatAuthToken: '' }));
  }
}

export function getUser(): User {
  if (isStorageAvailable('localStorage')) {
    const user = localStorage.getItem(USER_LOCAL_STORAGE_KEY);
    return safeJsonParse(user, defaultUser, USER_LOCAL_STORAGE_KEY);
  }
  return defaultUser;
}

export function removeUser(): void {
  if (isStorageAvailable('localStorage')) {
    localStorage.removeItem(USER_LOCAL_STORAGE_KEY);
  }
}
