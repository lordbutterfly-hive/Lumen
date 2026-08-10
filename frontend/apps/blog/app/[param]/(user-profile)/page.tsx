import Content from './content';
import PostsPage from '@/blog/features/account-profile/posts-page';
import { extractUsernameFromParam, isUsernameValid } from '@/blog/utils/validate-links';
import { notFound } from 'next/navigation';

// 'posts' (author-only) — NOT 'blog', which also pulls in reblogs.
//
// ★ OWNER RULING, 2026-08-08: a profile shows what that person WROTE. Reblogs
// belong in the Following feed on the home page, not here. This was briefly
// changed to 'blog' and reverted the same day — do not "fix" it again.
//
// This prefetch SEEDS page 1 of the redesigned Posts tab (PostsPage ->
// InitialPostsProvider -> ProfilePostsList -> useAccountEntries's
// `initialData`), so it must stay in lockstep with that hook's sort
// (BRIDGE_SORT_FOR_QUERY.posts). When the two disagree, the seeded first page
// wins for the whole staleTime and silently overrides the hook.
const query = 'posts';

const Page = async ({ params }: { params: { param: string } }) => {
  const username = extractUsernameFromParam(params.param);
  if (!username) notFound();

  const valid = await isUsernameValid(username);
  if (!valid) notFound();

  return (
    <PostsPage param={params.param} query={query}>
      <Content />
    </PostsPage>
  );
};

export default Page;
