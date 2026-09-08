import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookieNamePrefix } from '@smart-signer/lib/session';
import { sealLoginChallenge, IRON_SEAL_PREFIX } from '@smart-signer/lib/challenge-seal';

export const setLoginChallengeCookies = async (req: NextRequest, res: NextResponse) => {
  // SMS-01 (2026-09-08): the server half is now SEALED (see challenge-seal.ts),
  // so a non-browser caller can no longer forge it and supply both sides of the
  // login-challenge comparison. The JS-visible client half stays plaintext — the
  // signer legitimately reads it to build the op the wallet signs.
  //
  // Mint when EITHER half is missing (found in review: a visitor holding the
  // server half but not the JS-visible half could never obtain one, and
  // ensureLoginChallenge would loop through /api/users/me for nothing) OR when
  // the server half is a LEGACY plaintext value from before this fix. That last
  // case transparently upgrades returning visitors to a sealed pair on their
  // next request, with only a cheap prefix test (no unseal) per request: a real
  // seal always starts with iron's `Fe26.2` token prefix, a legacy UUID never
  // does.
  const serverHalf = req.cookies.get(`${cookieNamePrefix}login_challenge_server`)?.value;
  const hasSealedServerHalf = !!serverHalf && serverHalf.startsWith(IRON_SEAL_PREFIX);
  const hasClientHalf = req.cookies.has(`${cookieNamePrefix}login_challenge`);

  if (!hasSealedServerHalf || !hasClientHalf) {
    const loginChallenge = crypto.randomUUID();
    const sealedChallenge = await sealLoginChallenge(loginChallenge);

    // Set login challenge cookies
    res.cookies.set({
      name: `${cookieNamePrefix}login_challenge_server`,
      value: sealedChallenge,
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
