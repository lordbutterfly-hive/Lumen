import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { hasCsrfHeader } from '@/blog/lib/lite/http/csrf';
import { getLiteSession, destroyLiteSession } from '@/blog/lib/lite/http/session';
import { requireLiteUser } from '@/blog/lib/lite/http/actor';
import { bumpSessionEpoch } from '@/blog/lib/lite/repositories/user-repository';
import { revokeSessionId } from '@/blog/lib/lite/repositories/session-revocation-repository';

const logger = getLogger('app');

/**
 * POST /api/lite/auth/logout — sign out THIS DEVICE. CSRF header required.
 *
 * ★★★ 2026-08-10 — TWO BUGS, ONE ROUTE. Both live-reproduced before this rewrite.
 *
 * The route used to bump the account-wide `session_epoch` with NO epoch check, NO
 * actor check and no `guardWrite` — the one acting route that skipped what
 * `http/actor.ts` and `auth/account-status.ts` enforce everywhere else.
 *
 *  (a) A CAPTURED COOKIE WAS A PERMANENT LOCKOUT WEAPON. A cookie that 401s on
 *      every other route returned 200 here and advanced the epoch. Measured: a
 *      stale cookie got `{"status":"ok"}` and moved the epoch 1 -> 2, which killed
 *      the victim's freshly re-authenticated session — replayable forever, and
 *      `logout-all` was no remedy because logout-all is the same operation the
 *      attacker was calling.
 *
 *  (b) THE "EPOCH DRIFT" WAS THIS. The epoch is per-USER; "log out" in this
 *      product is per-DEVICE (`use-sign-out.tsx` routes every lite sign-out here).
 *      So signing out in one tab silently signed the user out of every other tab,
 *      phone and laptop. Measured: the phone signing out took the laptop and the
 *      tablet with it, epoch 0 -> 1. 17 of 209 accounts sit above epoch 0 because
 *      of this, and an earlier attempt to enforce the epoch on `/api/users/me` was
 *      reverted precisely because users were being signed out "on almost every
 *      action" — this is the drift that session was asking to have explained.
 *
 * THE FIX IS BOTH HALVES, AND NEITHER WORKS ALONE. The actor check closes (a); it
 * would not close (b), because a legitimate sign-out would still revoke the
 * account. Not bumping the epoch closes (b); alone it would reopen the hole the
 * 2026-08-06 bump was added for — a COPY of the cookie captured beforehand would
 * survive the sign-out and keep reading the account's private data. So the cookie
 * now carries a per-device `sessionId` and this route revokes exactly that one
 * (0034_session_revocation.sql), while `logout-all` keeps the account-wide bump.
 *
 * NO RATE LIMIT, DELIBERATELY, AND NOT AN OVERSIGHT. Post-fix the operation is
 * self-limiting: it needs a session that currently acts, and it ends by making
 * that session stop acting, so one cookie buys exactly one revocation. A limiter
 * here could only ever do harm — the failure mode of a rate-limited sign-out is a
 * user who cannot sign out.
 *
 * A missing/expired session is still cleared silently rather than 401'd (unlike
 * `logout-all`), so a stale cookie can always be got rid of.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!hasCsrfHeader(req)) {
    return NextResponse.json({ error: 'missing_csrf_header' }, { status: 403 });
  }
  try {
    const session = await getLiteSession();
    const user = session.user;

    // Not a lite session at all (absent, or a full-Hive login that reached the
    // wrong route): there is no server-side state to revoke. Clear the cookie and
    // say so — this is the "a stale cookie can always be got rid of" case.
    if (!user?.userId || user.account_tier !== 'lite') {
      await destroyLiteSession();
      return NextResponse.json({ status: 'ok' });
    }

    // ★ THE SAME GATE EVERY OTHER ACTING ROUTE USES. `requireLiteUser`, not
    // `requireActiveLiteUser`: a suspended account must still be able to sign out
    // — blocking that would punish the person for leaving. What it does check is
    // REVOCATION, which is the whole point: a cookie that is already dead must not
    // be able to reach in and revoke anything.
    const actor = await requireLiteUser(user, session);
    if (!actor.ok) {
      // The caller's browser should not keep a cookie the server refuses, so it is
      // still cleared. Server state is NOT touched — that is what made the replay
      // a weapon.
      await destroyLiteSession();
      return actor.response;
    }

    if (session.sessionId) {
      // The ordinary path: revoke THIS device and leave every other one signed in.
      // Awaited and allowed to throw — a sign-out reported as done but not written
      // is exactly the "logout was a security control that controlled nothing"
      // failure this route already shipped once.
      await revokeSessionId(actor.user.userId, session.sessionId);
    } else {
      // A cookie issued before per-device ids existed. There is no id to revoke, so
      // the honest options are "bump the account" or "let a captured copy live on",
      // and only the first is a sign-out. It costs this user their other devices,
      // once, and stops happening as soon as they sign in again. Every session
      // issued from now on takes the branch above.
      await bumpSessionEpoch(actor.user.userId);
    }

    await destroyLiteSession();
    return NextResponse.json({ status: 'ok' });
  } catch (error) {
    logger.error(error, 'Lite logout failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
