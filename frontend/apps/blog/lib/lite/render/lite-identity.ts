import { findLiteUserByPublicName } from './public-name';

/**
 * Is this name a Lumen lite account rather than a Hive account?
 *
 * Used where a surface has to behave differently for a keyless user — the avatar
 * route being the first case, since a lite user has no Hive account and therefore no
 * hosted avatar to fetch.
 *
 * Deliberately checks the DB rather than guessing from the name's shape: a lite
 * display name is a valid Hive-format name by construction, so it is
 * indistinguishable syntactically.
 */
export async function isLiteDisplayName(name: string): Promise<boolean> {
  try {
    // ★ GUARDED (2026-09-10): a Hive account that took this name must never be
    // served the lite account's picture. See ./public-name.ts.
    const user = await findLiteUserByPublicName(name);
    return Boolean(user);
  } catch {
    // Never let a datastore hiccup change what a normal Hive avatar request does.
    return false;
  }
}

/**
 * The picture a lite user chose, if any, plus whether the name is a Lumen account at
 * all. One lookup for both answers, because the avatar endpoint needs them together:
 * a lite account with no picture falls back to a generated one, and a name we do not
 * know keeps the ordinary Hive behaviour.
 */
export async function liteAvatar(
  name: string
): Promise<{ isLite: boolean; imageUrl: string | null; keyless: boolean }> {
  try {
    // ★ GUARDED (2026-09-10): a Hive account that took this name must never be
    // served the lite account's picture. See ./public-name.ts.
    const user = await findLiteUserByPublicName(name);
    if (!user) return { isLite: false, imageUrl: null, keyless: false };
    const image = user.avatarUrl || user.profile?.profile_image || '';
    /**
     * ★ `keyless` DISTINGUISHES "NO HIVE ACCOUNT" FROM "HAS ONE TOO" (2026-09-11).
     *
     * `isLite` alone conflates two different people. An UPGRADED user owns both this
     * lite row and a real Hive account of the same name, and the picture they manage
     * on chain is the one they expect to see; a keyless lite user has no chain
     * account at all, so the only true picture is the one stored here.
     *
     * The avatar route needs the difference because it now resolves lite FIRST (see
     * its own comment): without this flag, moving the lite lookup ahead of the image
     * host would start overriding an upgraded user's own Hive avatar with whatever
     * their pre-upgrade lite row happened to hold. Same rule as
     * `liteAccountAsProfile`, which refuses an upgraded user for the same reason.
     */
    const keyless = user.accountTier !== 'full' && !user.hiveAccountName;
    return { isLite: true, imageUrl: image || null, keyless };
  } catch {
    return { isLite: false, imageUrl: null, keyless: false };
  }
}

/**
 * Is this public name a Lumen account with NO Hive account behind it?
 *
 * ★★★ THE PREDICATE THE CHAIN-BACKED ROUTES WERE MISSING (2026-09-11).
 *
 * "Is this a lite account" is not the question those routes need; "does this name have
 * a chain identity whose data would be TRUE for it" is. An upgraded user answers yes
 * to the first and no to the second, and asking the wrong one would have started
 * hiding upgraded users' real on-chain followers and balances.
 *
 * Keyless is the case where a Hive answer cannot be right: either the chain has never
 * heard of the name (so the call fails) or the account it finds belongs to somebody
 * else (a squatter). Both were being rendered as this account's own data.
 */
export async function isKeylessLiteName(name: string): Promise<boolean> {
  try {
    const user = await findLiteUserByPublicName(name);
    return Boolean(user && user.accountTier !== 'full' && !user.hiveAccountName);
  } catch {
    // A datastore hiccup must not silently reclassify an account. Falling back to
    // "not keyless" keeps the previous, chain-backed behaviour rather than blanking a
    // real Hive account's list.
    return false;
  }
}
