import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookieNamePrefix } from '@smart-signer/lib/session';

export const setLoginChallengeCookies = (req: NextRequest, res: NextResponse) => {
  // Mint when EITHER half is missing (found in review: a visitor holding the
  // server half but not the JS-visible half could never obtain one, and
  // ensureLoginChallenge would loop through /api/users/me for nothing).
  const hasServerHalf = req.cookies.has(`${cookieNamePrefix}login_challenge_server`);
  const hasClientHalf = req.cookies.has(`${cookieNamePrefix}login_challenge`);

  if (!hasServerHalf || !hasClientHalf) {
    const loginChallenge = crypto.randomUUID();

    // Set login challenge cookies
    res.cookies.set({
      name: `${cookieNamePrefix}login_challenge_server`,
      value: loginChallenge,
      path: '/',
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true
    });
    res.cookies.set({
      name: `${cookieNamePrefix}login_challenge`,
      value: loginChallenge,
      path: '/',
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      httpOnly: false
    });
  }
};
