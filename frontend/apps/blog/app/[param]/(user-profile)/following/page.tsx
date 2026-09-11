import FollowingContent from './content';
import { getFollowingCached } from '@/blog/lib/cached-api';
import { extractUsernameFromParam } from '@/blog/utils/validate-links';
import { notFound } from 'next/navigation';
import { getLogger } from '@ui/lib/logging';
import { isKeylessLiteName } from '@/blog/lib/lite/render/lite-identity';

const logger = getLogger('app');
const LIMIT = 50;

/**
 * ★ THE ROUTE IS `/following`, NOT `/followed` (redesign spec, "Copy and routing
 * changes"). The page heading, the profile stat tile and every label in the
 * product already said "Following"; only the URL and the body copy said
 * "Followed", and the body copy said it ungrammatically ("Followed page 1 from
 * 5"). `../followed/page.tsx` is now a permanent redirect here, so every link
 * anyone has ever shared still lands.
 */
const FollowingPage = async ({ params }: { params: { param: string } }) => {
  const username = extractUsernameFromParam(params.param);
  if (!username) notFound();

  let initialFollowing = null;
  /**
   * ★★★ THE SSR SEED HAD TO LEARN THE SAME RULE AS THE ROUTE (2026-09-11).
   *
   * Fixing `/api/following` alone would not have shown up here. This seed calls the chain
   * helper DIRECTLY, and it is handed to the client as `initialData` with
   * `initialDataUpdatedAt: Date.now()` -- i.e. fresh -- so for a squatted name the
   * squatter's follower rows would have been server-rendered and then treated as
   * up-to-date, and the corrected route would never have been asked.
   *
   * Seeding nothing is not a regression: the client already fetches when there is no
   * seed, and for a keyless account that fetch now resolves to Lumen's own follow
   * table. It costs a keyless account one round trip and gets it the right answer.
   */
  if (await isKeylessLiteName(username)) {
    return <FollowingContent username={username} initialFollowing={null} />;
  }

  try {
    // ★ CACHED (2026-09-05, perf batch C-A). See getFollowingCached's own doc
    // comment in lib/cached-api.ts -- neither result is viewer-dependent, so a
    // 30s cross-request cache is safe here the way it is not for anything
    // transactional.
    initialFollowing = (await getFollowingCached({ account: username, start: '', limit: LIMIT })) ?? null;
  } catch (error) {
    logger.error(error, 'Error fetching following list:');
  }

  return <FollowingContent username={username} initialFollowing={initialFollowing} />;
};

export default FollowingPage;
