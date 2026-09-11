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
 * The writer's picture for a SINGLE post. One query, same row as
 * {@link resolvePublicName}; prefer {@link resolvePublicAvatars} for a list.
 *
 * Returns undefined rather than '' when there is no picture, so a caller can spread it
 * into an overlay without inventing an empty string that later reads as "a picture we
 * have". See LiteIdentity.avatarUrl for why the overlay needs it at all.
 */
export async function resolvePublicAvatar(post: LumenPost): Promise<string | undefined> {
  const user = await users.findUserById(post.userId).catch(() => null);
  return user?.avatarUrl || user?.profile?.profile_image || undefined;
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

/**
 * The writer's own picture per post id, from the SAME rows `resolvePublicNames` reads.
 *
 * ★ SEPARATE FUNCTION, SHARED QUERY (2026-09-11). `attachLiteIdentities` already calls
 * `resolvePublicNames`, and the avatar comes off the identical `lumen_user` row, so
 * this takes the map that call already built rather than issuing a second query per
 * feed page. See `LiteIdentity.avatarUrl` for why a byline needs it: without a picture
 * on the overlay, every byline falls back to the name-keyed Hive image host, which for
 * a squatted handle serves the squatter.
 *
 * Empty entries are omitted rather than stored as '', so a caller can treat "absent"
 * as "no picture, use the monogram" without a second falsiness check.
 */
export async function resolvePublicAvatars(list: LumenPost[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (list.length === 0) return out;

  const found = await users.findUsersByIds([...new Set(list.map((post) => post.userId))]).catch(() => []);
  const byId = new Map(found.map((user) => [user.userId, user]));
  for (const post of list) {
    const user = byId.get(post.userId);
    const image = user?.avatarUrl || user?.profile?.profile_image || '';
    if (image) out.set(post.postId, image);
  }
  return out;
}
