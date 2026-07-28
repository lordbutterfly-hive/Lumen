import { User } from '@smart-signer/types/common';
import * as users from '../repositories/user-repository';
import { LumenUser } from '../types';

/**
 * "Is this session still allowed to act?" — checked against the DB, not the cookie.
 *
 * Login already refuses a suspended or banned account (auth/auth-service.ts), but a
 * session issued BEFORE the suspension keeps working for as long as the cookie lives:
 * every write path trusted `account_tier` alone, so suspending an account did not
 * stop the account. That made `lumen_user.status` decorative — the value could be
 * written but changed nothing.
 *
 * One extra read per write. Every one of these paths already touches the database,
 * and a moderation decision that only applies at next login is not a moderation
 * decision.
 */

export type ActorCheck =
  | { ok: true; user: LumenUser }
  | { ok: false; status: number; code: string; message: string };

const MESSAGES: Record<string, string> = {
  suspended: 'This account is suspended.',
  banned: 'This account has been banned.',
  upgraded: 'This account is now a full Hive account — sign in with your own keys.'
};

export async function checkLiteActor(sessionUser: User | undefined): Promise<ActorCheck> {
  if (!sessionUser?.userId || sessionUser.account_tier !== 'lite') {
    return { ok: false, status: 401, code: 'unauthorized', message: 'Not signed in as a lite account.' };
  }
  return checkLiteActorById(sessionUser.userId);
}

export async function checkLiteActorById(userId: string): Promise<ActorCheck> {
  const user = await users.findUserById(userId);
  // The row is gone but the cookie is not: treat as signed out rather than 500.
  if (!user) {
    return { ok: false, status: 401, code: 'unauthorized', message: 'Account not found.' };
  }
  if (user.status !== 'active') {
    return {
      ok: false,
      // 403, not 401: the session is valid, the account is not permitted to act.
      // A 401 would send the client into a re-login loop that can never succeed.
      status: 403,
      code: `account_${user.status}`,
      message: MESSAGES[user.status] ?? 'This account cannot post right now.'
    };
  }
  return { ok: true, user };
}
