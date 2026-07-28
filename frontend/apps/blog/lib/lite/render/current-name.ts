import { LumenPost, LumenUser } from '../types';
import * as users from '../repositories/user-repository';

/**
 * Which name a reader should see on a post.
 *
 * `display_name_snapshot` is frozen on the post row at publish time, because the
 * on-chain footer ("Posted via Lumen by X") is broadcast once and can never be
 * rewritten. That makes it the right record of what WAS published — and the wrong
 * thing to display.
 *
 * A user who upgrades gets a new Hive account under a NEW name (their Lumen handle
 * is not reserved on Hive and is often taken). Their Lumen history has to follow
 * them: `user_id` never changes across the upgrade, so every old post is still
 * theirs and must show their current name. Rendering the snapshot instead would
 * leave a profile full of posts bylined with a name that no longer exists.
 *
 * Order is deliberate:
 *   1. `hive_account_name` — they upgraded; this is their real, on-chain identity
 *   2. `display_name` — still lite; this is their current Lumen handle
 *   3. the snapshot — the user row is gone; better a stale name than a blank byline
 */
export function publicNameOf(post: LumenPost, user: LumenUser | null | undefined): string {
  return user?.hiveAccountName || user?.displayName || post.displayNameSnapshot;
}

/** Single post. Prefer {@link resolvePublicNames} for lists — this is one query. */
export async function resolvePublicName(post: LumenPost): Promise<string> {
  const user = await users.findUserById(post.userId).catch(() => null);
  return publicNameOf(post, user);
}

/**
 * Whole page of posts in ONE query. Returns a map keyed by post id, so callers do
 * not have to re-derive the pairing.
 */
export async function resolvePublicNames(list: LumenPost[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (list.length === 0) return out;

  const found = await users.findUsersByIds([...new Set(list.map((post) => post.userId))]).catch(() => []);
  const byId = new Map(found.map((user) => [user.userId, user]));
  for (const post of list) out.set(post.postId, publicNameOf(post, byId.get(post.userId)));
  return out;
}
