import { extractUsernameFromParam } from '@/blog/utils/validate-links';
import { notFound, redirect } from 'next/navigation';

/**
 * ★ REDIRECT, NOT RENDER — DEAD UPSTREAM SURFACE (owner ruling, 2026-08-12).
 *
 * This page rendered Hive's "follow another account's blacklist" feature
 * (`bridge.get_follow_list(username, 'follow_blacklist')`). Lumen never built a
 * UI to subscribe to one — there is no control anywhere in the product that
 * writes to this list — and it is empty in practice: confirmed live against
 * `lordbutterfly`, `follow_blacklist` returns zero rows. It is an inherited
 * Denser (upstream Hive blog) route Lumen never adopted as a product concept,
 * not a second kind of moderation list sitting alongside Block. Redirected
 * rather than deleted so an old link or bookmark does not 404 — see
 * `(posts-tabs)/comments/page.tsx` for the same pattern.
 */
const FollowedBlacklistPage = ({ params }: { params: { param: string } }) => {
  const username = extractUsernameFromParam(params.param);
  if (!username) notFound();

  redirect(`/@${username}/settings#blocked-accounts`);
};
export default FollowedBlacklistPage;
