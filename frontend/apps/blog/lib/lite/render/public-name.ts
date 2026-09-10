import * as users from '../repositories/user-repository';
import type { LumenUser } from '../types';

/**
 * ★★★ ONE NAME, TWO NAMESPACES, AND ONLY ONE OF THEM IS OURS (2026-09-10, owner:
 * "someone made a chadmaster lite account and then someone made a real hive
 * chadmaster account... apparently the real hive account inherited the lite accounts
 * history. thats a massive bug, that cannot happen").
 *
 * Lite signup vets a name against BOTH namespaces and fails closed -- `auth-service.ts`
 * checks `findUserByDisplayName` for Lumen and `checkAccountExists` for Hive, and
 * refuses on either hit or on a node error. So a lite handle is provably free on Hive
 * the moment it is issued. What no code did was re-check, and Hive's namespace is
 * open: anyone can register that same name a day later.
 *
 * From that moment `findUserByDisplayName(name)` -- which the avatar route, the lite
 * posts route, the follow list, the follow/block actors and the moderation route all
 * call directly -- keeps answering with the LITE user, so the newcomer's identity
 * resolves to somebody else's account. REPRODUCED 2026-09-10 against the shipped code
 * by seeding a lite user named `daveks` (a real Hive account since 2016):
 * `GET /api/lite/posts?author=daveks` returned the lite user's post with
 * `author: "daveks"`.
 *
 * This is the guarded resolver every PUBLIC, NAME-KEYED surface must use instead.
 * `findUserByDisplayName` stays for the paths that are keyed on a name the CALLER
 * owns -- signup vetting, the upgrade's own collision checks, anything already inside
 * an authenticated session for that user.
 *
 * ★ IT READS A STORED VERDICT, NOT THE CHAIN. The flag is written by the squatter
 * sweep (`lib/lite/moderation/name-squatters.ts`). Two reasons it is not an inline
 * chain call: the hot paths here run per avatar, per profile and per feed card, and a
 * Hive outage must not be able to change who a name resolves to -- in either
 * direction. A stored verdict is the same answer whether or not a node is up.
 */

/** Does this user still own its display name for public, name-keyed lookups? */
export function ownsPublicName(user: LumenUser, name: string): boolean {
  const clean = name.trim().toLowerCase();
  // Their OWN upgrade is not a conflict: an upgraded user legitimately holds the lite
  // handle and the Hive account, and the sweep never flags that pair.
  if ((user.hiveAccountName ?? '').toLowerCase() === clean) return true;
  return user.nameConflictAt == null;
}

/**
 * The lite account this public name belongs to, or `null` when the name is contested.
 *
 * `null` is deliberately the same answer a caller already gets for "not a Lumen
 * account", which is the honest description of a contested name: on a name Hive now
 * owns, Lumen has no lite identity it is entitled to serve.
 */
export async function findLiteUserByPublicName(name: string): Promise<LumenUser | null> {
  const clean = name.trim().toLowerCase();
  if (!clean) return null;
  const user = await users.findUserByDisplayName(clean);
  if (!user) return null;
  return ownsPublicName(user, clean) ? user : null;
}
