import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { getFollowCount } from '@transaction/lib/hive-api';
import { findLiteUserByPublicName } from '@/blog/lib/lite/render/public-name';
import * as follows from '@/blog/lib/lite/repositories/follow-repository';

const logger = getLogger('app');

/**
 * ★ Same rule as `/api/account`. `components/hooks/use-follows.ts` called
 * `getFollowCount` directly — it reaches `getChain()` and downloads
 * `wax.common.wasm`. This hook backs the follower/following numbers on every
 * author hover-card (`popover-card-data.tsx`), which is one of the highest-
 * traffic reads in the app: it fires on hover over any author name in any
 * post list, for any visitor, signed in or not.
 *
 * NOT CACHED: follow counts change on every follow/unfollow, and this is
 * cheap enough (one `bridge.get_profile` call) that staleness buys little.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const username = (req.nextUrl.searchParams.get('username') ?? '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9.-]{1,15}$/.test(username)) {
    return NextResponse.json({ error: 'username_required' }, { status: 400 });
  }
  /**
   * ★★★ A LUMEN ACCOUNT'S FOLLOWERS ARE NOT ON HIVE (2026-09-11).
   *
   * This route asked `bridge.get_profile` for the bare name and returned whatever came
   * back, which is wrong in two different ways for two different accounts:
   *
   *   · A keyless lite account has NO Hive account, so the call failed and this
   *     answered 502 -- on the hook that backs every author hover-card.
   *   · A SQUATTED name does have a Hive account, someone else's, so this answered
   *     with the squatter's numbers presented as the victim's. Measured on production
   *     2026-09-11: `/api/follow-count?username=luxattack` returned `follower_count: 1`
   *     (the squatter's follower) while that lite account's true count was 0.
   *
   * The lite follow graph lives in Postgres and `liteAccountAsProfile` has always
   * reported it correctly on the profile header, which is why the header count and
   * this number could disagree about the same account. Same resolver, same table, so
   * they cannot disagree any more. An UPGRADED user keeps the chain answer: they have
   * a real account and a real on-chain graph.
   */
  const lite = await findLiteUserByPublicName(username).catch((error) => {
    logger.warn(error, 'follow-count: lite lookup failed for %s', username);
    return null;
  });
  if (lite && lite.accountTier !== 'full' && !lite.hiveAccountName) {
    const actor = { userId: lite.userId };
    const [follower_count, following_count] = await Promise.all([
      follows.countFollowers(actor),
      follows.countFollowing(actor)
    ]);
    return NextResponse.json(
      { account: lite.displayName, follower_count, following_count },
      { headers: { 'cache-control': 'private, no-store' } }
    );
  }

  try {
    const followStats = await getFollowCount(username);
    return NextResponse.json(followStats, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    logger.error(error, 'follow count lookup failed for %s', username);
    return NextResponse.json({ error: 'follow_count_unavailable' }, { status: 502 });
  }
}
