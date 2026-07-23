import { cookies } from 'next/headers';
import { getIronSession, IronSession } from 'iron-session';
import { sessionOptions } from '@smart-signer/lib/session';
import { IronSessionData } from '@smart-signer/types/common';

/**
 * App Router iron-session access for lite-account routes. Reuses the app's
 * existing `sessionOptions` (same encrypted cookie), so a lite session and a
 * full-Hive session are indistinguishable at the cookie layer — only the
 * `account_tier` field differs. Server-side only; call inside route handlers.
 */

export async function getLiteSession(): Promise<IronSession<IronSessionData>> {
  return getIronSession<IronSessionData>(cookies(), sessionOptions);
}

export async function destroyLiteSession(): Promise<void> {
  const session = await getLiteSession();
  session.destroy();
  // Clear the analytics parity cookie set at login.
  cookies().set('account_info', '', { path: '/', maxAge: 0 });
}
