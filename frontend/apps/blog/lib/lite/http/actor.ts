import { NextResponse } from 'next/server';
import { User } from '@smart-signer/types/common';
import { LumenUser } from '../types';
import { checkLiteActor } from '../auth/account-status';
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
 */

export type ActorResult = { ok: true; user: LumenUser } | { ok: false; response: NextResponse };

export async function requireActiveLiteUser(sessionUser: User | undefined): Promise<ActorResult> {
  const check = await checkLiteActor(sessionUser);
  if (check.ok) return { ok: true, user: check.user };
  return {
    ok: false,
    response: NextResponse.json({ error: check.code, message: check.message }, { status: check.status })
  };
}

export async function requireLiteUser(sessionUser: User | undefined): Promise<ActorResult> {
  if (!sessionUser?.userId || sessionUser.account_tier !== 'lite') {
    return { ok: false, response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) };
  }
  const user = await findUserById(sessionUser.userId);
  if (!user) {
    return { ok: false, response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) };
  }
  return { ok: true, user };
}
