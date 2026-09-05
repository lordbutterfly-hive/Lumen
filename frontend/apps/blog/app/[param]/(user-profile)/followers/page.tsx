import FollowersContent from './content';
import { getFollowersCached } from '@/blog/lib/cached-api';
import { extractUsernameFromParam } from '@/blog/utils/validate-links';
import { notFound } from 'next/navigation';
import { getLogger } from '@ui/lib/logging';

const logger = getLogger('app');
const LIMIT = 50;

const FollowersPage = async ({ params }: { params: { param: string } }) => {
  const username = extractUsernameFromParam(params.param);
  if (!username) notFound();

  let initialFollowers = null;
  try {
    // ★ CACHED (2026-09-05, perf batch C-A). See getFollowersCached's own doc
    // comment in lib/cached-api.ts -- neither result is viewer-dependent, so a
    // 30s cross-request cache is safe here the way it is not for anything
    // transactional.
    initialFollowers =
      (await getFollowersCached({ account: username, start: '', type: 'blog', limit: LIMIT })) ?? null;
  } catch (error) {
    logger.error(error, 'Error fetching followers list:');
  }

  return <FollowersContent username={username} initialFollowers={initialFollowers} />;
};

export default FollowersPage;
