import Content from './content';
import PostsPage from '@/blog/features/account-profile/posts-page';
import { extractUsernameFromParam, isUsernameValid } from '@/blog/utils/validate-links';
import { notFound } from 'next/navigation';

// 'posts': the Posts tab. With reblog comments on (2026-09-24, owner: "allow plain
// reblogs on your profile") PostsPage renders it as own posts AND reblogs merged
// (`sort=profile`); with them off, author-only as the 2026-08-08 ruling had it. See
// BRIDGE_SORT_FOR_QUERY in use-account-entries.ts.
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
