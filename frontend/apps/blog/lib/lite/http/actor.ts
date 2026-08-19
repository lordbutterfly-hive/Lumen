import { NextResponse } from 'next/server';
import { User } from '@smart-signer/types/common';
import { LumenUser, SessionRef } from '../types';
import { checkLiteActor, checkSessionValidity } from '../auth/account-status';
import { findUserById } from '../repositories/user-repository';

/**
 * Route-level "who is acting, and may they?" for lite endpoints.
 *
 * Every engagement route repeated the same four lines and checked only the COOKIE
 * (`userId` present + `account_tier === 'lite'`), so a suspension had no effect on a
 * session issued before it. These two helpers replace that check and make the
 * distinction the routes actually need explicit:
 *
 *  - {@link requireActiveLiteUser} for anything that ADDS something — post, vote,
 *    reblog, follow. Suspension stops these.
 *  - {@link requireLiteUser} for anything that WITHDRAWS something — unfollow,
 *    un-reblog, clearing a vote. A suspended account must still be able to take back
 *    what it did; blocking that would punish the retraction, not the behaviour.
 *
 * ★★★ QA 2026-08-06 — THE STATUS EXEMPTION ABOVE IS DELIBERATE AND STAYS. THE
 * SESSION-EPOCH EXEMPTION WAS NOT, AND IS FIXED HERE.
 *
 * `requireLiteUser` did not accept `sessionEpoch` at all, so it could not check
 * it — which quietly conflated two unrelated things:
 *
 *   1. ACCOUNT STATUS (suspended / banned) — exempted on purpose, for the good
 *      reason given above. Unchanged.
 *   2. SESSION REVOCATION (`logout-all`, or an admin invalidating sessions) —
 *      never intended to be exempt. The user explicitly said "stop this
 *      session"; a revoked cookie must not act, whatever the action is.
 *
 * Reproduced live by two QA seats independently: after `logout-all` bumped
 * `session_epoch` 0 -> 1, a replayed OLD cookie still returned 200 on
 * `GET /api/lite/profile`, `POST /api/lite/unfollow`,
 * `POST /api/lite/vote {weight:0}` and `POST /api/lite/reblog {undo:true}` — and
 * the unfollow really mutated the database (`lumen_follow.active` true -> false).
 *
 * Withdrawal routes therefore now pass the caller's session and a stale cookie is
 * refused with `session_revoked`, exactly as the adding routes already were.
 *
 * ★★★ 2026-08-10 — AND THE SECOND ARGUMENT IS NOW THE WHOLE SESSION, NOT ONE FIELD.
 *
 * Every hole this subsystem has shipped was a caller that failed to pass one loose
 * field: `requireLiteUser` could not accept `sessionEpoch` at all, and a cookie
 * carrying no stamp was exempted by an `!== undefined` guard. Per-device sign-out
 * adds a second such field (`sessionId`), and threading it as another optional
 * positional would have set the same trap a third time — a route that forgot it
 * would compile, run, and silently exempt itself from revocation.
 *
 * Taking `SessionRef` means routes pass `session` (an iron session satisfies the
 * shape), a forgotten argument is a TYPE ERROR, and the next field added to a
 * session costs zero call sites.
 */

export type ActorResult = { ok: true; user: LumenUser } | { ok: false; response: NextResponse };

export async function requireActiveLiteUser(
  sessionUser: User | undefined,
  session: SessionRef,
  options: { allowUpgraded?: boolean } = {}
): Promise<ActorResult> {
  const check = await checkLiteActor(sessionUser, session, options);
  if (check.ok) return { ok: true, user: check.user };
  return {
    ok: false,
    response: NextResponse.json({ error: check.code, message: check.message }, { status: check.status })
  };
}

export async function requireLiteUser(
  sessionUser: User | undefined,
  session: SessionRef
): Promise<ActorResult> {
  if (!sessionUser?.userId || sessionUser.account_tier !== 'lite') {
    return { ok: false, response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) };
  }
  const user = await findUserById(sessionUser.userId);
  if (!user) {
    return { ok: false, response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) };
  }
  // ★ Session revocation applies to withdrawals too — see the block comment
  // above. Status is deliberately NOT checked here; revocation is. Both kinds:
  // the account-wide epoch AND this device's own sign-out, in the one shared
  // implementation so the two entry points cannot drift apart.
  const revoked = await checkSessionValidity(user, session);
  if (revoked) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: revoked.code, message: 'This session has been signed out.' },
        { status: revoked.status }
      )
    };
  }
  return { ok: true, user };
}
