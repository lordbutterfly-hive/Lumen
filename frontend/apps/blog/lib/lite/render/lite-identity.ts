import * as users from '../repositories/user-repository';

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
    const user = await users.findUserByDisplayName(name.trim().toLowerCase());
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
): Promise<{ isLite: boolean; imageUrl: string | null }> {
  try {
    const user = await users.findUserByDisplayName(name.trim().toLowerCase());
    if (!user) return { isLite: false, imageUrl: null };
    const image = user.avatarUrl || user.profile?.profile_image || '';
    return { isLite: true, imageUrl: image || null };
  } catch {
    return { isLite: false, imageUrl: null };
  }
}
