import Content from './content';
import PostsPage from '@/blog/features/account-profile/posts-page';
import { extractUsernameFromParam, isUsernameValid } from '@/blog/utils/validate-links';
import { notFound } from 'next/navigation';

// 'posts' (author-only) — NOT 'blog', which also pulls in reblogs. This
// seeds the redesigned profile's Posts tab (ProfileGrid -> ... ->
// ProfilePostsList's useAccountEntries('posts', ...)); the query here MUST
// match that hook's query, or the SSR-prefetched initialEntries would
// briefly show reblogs before the client re-fetches with 'posts'.
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
