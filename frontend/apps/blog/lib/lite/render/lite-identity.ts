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
