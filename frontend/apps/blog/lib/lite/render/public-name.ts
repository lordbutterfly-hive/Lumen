import * as users from '../repositories/user-repository';
import type { LumenUser } from '../types';
import { liteConfig } from '../config';

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

/**
 * Is the Hive account that took this name a SQUATTER: registered after the lite
 * account, and not by us?
 *
 * Both halves matter. "After" is the whole claim -- the lite account demonstrably had
 * the name first, because signup proved it was free on Hive at that moment. "Not by
 * us" excludes the one legitimate way a Hive account appears under a name we issued,
 * which is our own upgrade path.
 */
export function isSquattedName(user: LumenUser, ourCreator: string): boolean {
  if (user.nameConflictAt == null || user.nameConflictCreated == null) return false;
  const creator = (user.nameConflictCreator ?? '').toLowerCase();
  const ours = !!creator && !!ourCreator && creator === ourCreator.toLowerCase();
  if (ours) return false;
  return user.nameConflictCreated.getTime() > user.createdAt.getTime();
}

/**
 * Does this user still own its display name for public, name-keyed lookups?
 *
 * ★ A SQUATTED NAME COMES BACK TO THE LITE ACCOUNT (2026-09-10, owner ruling). The
 * first cut of this guard resolved every contested name to nobody, which stopped the
 * squatter inheriting but also cost the VICTIM their own profile, posts and avatar --
 * punishing the person who was there first. Measured on production right after that
 * shipped: `/@chadmasters` served the squatter's brand-new Hive account (reputation
 * 25) while the lite account's two posts sat unreachable.
 *
 * So the three cases are separated:
 *   · no conflict, or the conflict IS this user's own upgrade -> theirs, obviously.
 *   · the Hive account was registered AFTER the lite account and not by us -> the
 *     lite account is the rightful owner of this name ON LUMEN, and the Hive account
 *     is banned instead (see lib/lite/moderation/squatter-list.ts).
 *   · anything else -- a Hive account that PREDATES the lite row, or one we cannot
 *     date -- is genuinely ambiguous, and an ambiguous name resolves to nobody.
 */
export function ownsPublicName(user: LumenUser, name: string, ourCreator = ''): boolean {
  const clean = name.trim().toLowerCase();
  // Their OWN upgrade is not a conflict: an upgraded user legitimately holds the lite
  // handle and the Hive account, and the sweep never flags that pair.
  if ((user.hiveAccountName ?? '').toLowerCase() === clean) return true;
  if (user.nameConflictAt == null) return true;
  return isSquattedName(user, ourCreator);
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
  return ownsPublicName(user, clean, liteConfig.accountCreatorAccount) ? user : null;
}
