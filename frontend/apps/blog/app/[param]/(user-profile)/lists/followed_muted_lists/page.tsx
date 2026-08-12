import { extractUsernameFromParam } from '@/blog/utils/validate-links';
import { notFound, redirect } from 'next/navigation';

/**
 * ★ REDIRECT, NOT RENDER — DEAD UPSTREAM SURFACE (owner ruling, 2026-08-12).
 *
 * Same as `../followed_blacklists/page.tsx`, one level over: this rendered
 * Hive's "follow another account's mute list" feature
 * (`bridge.get_follow_list(username, 'follow_muted')`). Lumen never surfaced a
 * way to subscribe to one, and it is empty in practice — confirmed live against
 * `lordbutterfly`, `follow_muted` returns zero rows. An inherited Denser route,
 * not a product concept Lumen adopted, redirected rather than deleted so an old
 * link or bookmark does not 404.
 */
const FollowedMutedListsPage = ({ params }: { params: { param: string } }) => {
  const username = extractUsernameFromParam(params.param);
  if (!username) notFound();

  redirect(`/@${username}/settings#blocked-accounts`);
};
export default FollowedMutedListsPage;
