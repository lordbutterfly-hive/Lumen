import { cookies } from 'next/headers';
import { getIronSession, IronSession } from 'iron-session';
import { sessionOptions } from '@smart-signer/lib/session';
import { IronSessionData } from '@smart-signer/types/common';
import { liteConfig } from '../config';

/**
 * App Router iron-session access for lite-account routes. Reuses the app's
 * existing `sessionOptions` (same encrypted cookie), so a lite session and a
 * full-Hive session are indistinguishable at the cookie layer — only the
 * `account_tier` field differs. Server-side only; call inside route handlers.
 */

// F-L3: augment the SHARED IronSessionData INTERFACE (legally, from our tree —
// `User` is a `type` alias and cannot be declaration-merged) so `sessionEpoch`
// is a typed SIBLING of `session.user`, never `session.user.sessionEpoch`
// (ts2353 on the alias). Stamped at issue (auth-service.issueSession) and
// compared against the DB row on every acting request (checkLiteActorById).
declare module '@smart-signer/types/common' {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface IronSessionData {
    sessionEpoch?: number;
    /**
     * WHICH DEVICE this cookie is, so a sign-out can revoke one session instead of
     * the account. Random per issue, stamped alongside the epoch and never read as
     * input from anywhere but the cookie itself; a listed id is refused
     * (repositories/session-revocation-repository.ts).
     *
     * Optional forever: cookies issued before this existed carry none, and for
     * those the epoch check stands alone exactly as it did — deploying per-device
     * revocation must not sign anybody out.
     */
    sessionId?: string;
  }
}

export async function getLiteSession(): Promise<IronSession<IronSessionData>> {
  // F-L3: wire the previously-dead `sessionTtlDays` into the cookie's maxAge.
  // CLONE the shared options (never mutate the packages export) so the full-Hive
  // session cookie is untouched — only lite routes flow through getLiteSession.
  // This adds no DB read: getLiteSession is called PRE-AUTH by completeSignup
  // before any user row exists, so it must stay a pure cookie accessor.
  const opts = {
    ...sessionOptions,
    cookieOptions: {
      ...sessionOptions.cookieOptions,
      maxAge: liteConfig.sessionTtlDays * 86400
    }
  };
  return getIronSession<IronSessionData>(cookies(), opts);
}

export async function destroyLiteSession(): Promise<void> {
  const session = await getLiteSession();
  session.destroy();
  // Clear the analytics parity cookie set at login.
  cookies().set('account_info', '', { path: '/', maxAge: 0 });
}
