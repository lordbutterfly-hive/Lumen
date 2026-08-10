import { extractUsernameFromParam } from '@/blog/utils/validate-links';
import { notFound, redirect } from 'next/navigation';

/**
 * ★ REDIRECT, NOT RENDER (owner report, 2026-08-08). This route still built
 * the legacy `ProfileLayout` chrome (dark cover banner, old "Blog / Social"
 * tabs) around the old `PostsContent('comments')` list — dense, hairline-only
 * rows, no `LeftRail`. It was the last surviving duplicate of a tab the
 * redesigned profile already has natively: `ProfileTabs` on the root
 * `/@username` page renders the exact same comments via `?tab=comments`
 * (see profile-tabs.tsx / profile-comments-list.tsx), with the Lumen 3-column
 * shell and bordered `ProfileCommentCard`s. `/@username/posts` and
 * `/@username/payout` were already deleted for this same reason (2026-08-06,
 * see features/layouts/account-posts/tabs.tsx) — this route gets a redirect
 * instead of a delete because old links/bookmarks to it still exist.
 */
const Page = ({ params }: { params: { param: string } }) => {
  const username = extractUsernameFromParam(params.param);
  if (!username) notFound();

  redirect(`/@${username}?tab=comments`);
};
export default Page;
