import PostsPage from '@/blog/features/account-profile/posts-page';
import { extractUsernameFromParam } from '@/blog/utils/validate-links';
import { isBannedAuthor } from '@/blog/lib/moderation/banned-authors';
import { notFound } from 'next/navigation';
import Content from './content';

const query = 'feed';

const Page = ({ params }: { params: { param: string } }) => {
  const username = extractUsernameFromParam(params.param);
  if (!username) notFound();

  // `/@someone/feed` is the ONE profile route that lives outside the
  // `(user-profile)` group, so it does not inherit that layout's ban gate and
  // needs its own. Without this a banned account would still have a working
  // page here — empty, because `getAccountPosts` refuses him, but a real 200
  // with his name in the header rather than a 404.
  if (isBannedAuthor(username)) notFound();

  return (
    <PostsPage param={params.param} query={query}>
      <Content />
    </PostsPage>
  );
};
export default Page;
