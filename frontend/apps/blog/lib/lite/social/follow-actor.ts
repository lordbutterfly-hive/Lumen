import { User } from '@smart-signer/types/common';
import * as users from '../repositories/user-repository';

/**
 * Who is on each end of a Lumen follow edge.
 *
 * Lumen shows two kinds of people side by side: lite accounts, which exist only in
 * our database, and real Hive accounts. Following has to work in all four
 * directions, but only one of them can live on chain — a Hive follow is a signed
 * operation, and a lite account has no key to sign with, nor an account to be
 * followed. So the other three are recorded here.
 *
 * A Lumen user is ALWAYS identified by `userId`, never by a name, and that is what
 * makes an upgrade free: the id does not change when a lite account becomes a Hive
 * account, so every edge keeps pointing at the same person and their followers move
 * with them. Resolving a name to an id (rather than storing the name) is also what
 * stops one person becoming two nodes in the graph after they upgrade.
 */

export type FollowActor = { userId: string; hive?: undefined } | { hive: string; userId?: undefined };

export function actorKey(actor: FollowActor): string {
  return actor.userId ? `u:${actor.userId}` : `h:${actor.hive}`;
}

export function sameActor(a: FollowActor, b: FollowActor): boolean {
  return actorKey(a) === actorKey(b);
}

/**
 * The actor for the current session — a lite account by id, a Hive login by name.
 *
 * Both session kinds are the same encrypted cookie (`http/session.ts`); only
 * `account_tier` differs, and the username in it was proved by a signed challenge at
 * login, so it can be trusted as the follower.
 */
export async function sessionActor(sessionUser: User | undefined): Promise<FollowActor | null> {
  if (!sessionUser?.isLoggedIn) return null;
  if (sessionUser.account_tier === 'lite') {
    return sessionUser.userId ? { userId: sessionUser.userId } : null;
  }
  if (!sessionUser.username) return null;
  const name = sessionUser.username.toLowerCase();
  // A Hive login can still be a Lumen account — this is exactly what an upgraded
  // user looks like. Storing them by name here would split their edges from the ones
  // they made as a lite account, so they would appear to lose everyone they followed
  // the moment they upgraded.
  const upgraded = await users.findUserByHiveAccountName(name);
  return upgraded ? { userId: upgraded.userId } : { hive: name };
}

export type AccountExistenceCheck = (name: string) => Promise<boolean>;

let existenceCheck: AccountExistenceCheck | null = null;

/** Injection seam — tests replace the chain lookup so they need no network. */
export function setAccountExistenceCheck(check: AccountExistenceCheck | null): void {
  existenceCheck = check;
}

async function hiveAccountExists(name: string): Promise<boolean> {
  if (existenceCheck) return existenceCheck(name);
  // Runtime import: the chain client pulls in @hiveio/wax, which has no CJS export
  // map, so a static import here makes this module unloadable from anything that is
  // not the Next bundle — ops scripts and tests import it transitively. The same trap
  // `names/vetting.ts` and `publisher/hive-broadcaster.ts` document.
  const { checkAccountExists } = await import('@transaction/lib/validation/existence/account');
  const existence = await checkAccountExists(name);
  // Only a definite "exists" counts. An API error is NOT read as existence: a node
  // hiccup would otherwise write an edge to an account that may not be real, and the
  // user can simply press the button again.
  return existence.status === 'exists';
}

export type TargetResolution =
  | { ok: true; actor: FollowActor; isLumenUser: boolean; isLite: boolean }
  | { ok: false; error: 'not_found' | 'invalid_name' };

/**
 * Resolve a display name to the actor it should be stored as.
 *
 * Lumen first: a name that belongs to a Lumen account — as its current handle or as
 * the Hive name it upgraded to — always resolves to that account's id. Only a name we
 * do not know is stored as a Hive account, and only after the chain confirms it
 * exists, so a typo cannot mint a node that no one can ever be.
 */
export async function resolveFollowTarget(name: string): Promise<TargetResolution> {
  const clean = name.trim().toLowerCase();
  if (!clean) return { ok: false, error: 'invalid_name' };

  const lumen =
    (await users.findUserByDisplayName(clean)) ?? (await users.findUserByHiveAccountName(clean));
  if (lumen) {
    // `isLite` is the one that decides WHERE the follow lives: an upgraded Lumen user
    // has a real Hive account, so another Hive user should follow them on chain like
    // anyone else. Only a keyless account forces the relationship off chain.
    const isLite = lumen.accountTier === 'lite' && !lumen.hiveAccountName;
    return { ok: true, actor: { userId: lumen.userId }, isLumenUser: true, isLite };
  }

  if (!(await hiveAccountExists(clean))) return { ok: false, error: 'not_found' };

  return { ok: true, actor: { hive: clean }, isLumenUser: false, isLite: false };
}
