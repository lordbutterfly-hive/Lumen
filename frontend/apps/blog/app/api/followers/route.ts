import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { isKeylessLiteName } from '@/blog/lib/lite/render/lite-identity';
import { getFollowers } from '@transaction/lib/hive-api';

const logger = getLogger('app');

/**
 * ★ Same rule as `/api/account`. `features/account-lists/hooks/use-
 * followers-infinitequery.tsx` (backing `/[param]/followers` and the author
 * hover-card's follower count) called `getFollowers` directly.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const account = (req.nextUrl.searchParams.get('account') ?? '').trim().toLowerCase();
  const start = req.nextUrl.searchParams.get('start') ?? '';
  const type = (req.nextUrl.searchParams.get('type') ?? 'blog').trim();
  const limitParam = req.nextUrl.searchParams.get('limit');
  const limit = limitParam && Number.isFinite(Number(limitParam)) ? Math.min(Number(limitParam), 1000) : 50;
  if (!/^[a-z][a-z0-9.-]{1,15}$/.test(account)) {
    return NextResponse.json({ error: 'account_required' }, { status: 400 });
  }

  /**
   * ★★★ A KEYLESS LUMEN ACCOUNT HAS NO CHAIN FOLLOW LIST, AND THE CHAIN'S ANSWER FOR
   * ITS NAME IS SOMEBODY ELSE'S (2026-09-11).
   *
   * Two failures, one cause. For an uncontested lite name `get_followers` threw
   * "Account does not exist" and this route turned it into a 502; the client's
   * fallback only recognises the ORIGINAL message, so the 502 propagated and the page
   * sat in an error/retry state (measured on production for `@arsha`, while the
   * sibling route answered `200 []` for the same account because only IT has the
   * does-not-exist branch). For a SQUATTED name the chain answers with the squatter's
   * real list, which is worse than an error because it looks like data: measured on
   * production 2026-09-11, `/@chadmasters/followers` rendered `@swarmpost`, who
   * follows the SQUATTER, while that lite account's real follower `@lordbutterfly`
   * appeared nowhere in the product.
   *
   * An empty first page is exactly the signal the client already acts on -- it falls
   * through to `liteFollowList`, which reads Lumen's own follow table through the
   * guarded resolver and applies the viewer's own block list. So the honest answer for
   * a keyless name is "no chain rows", and the correct list assembles itself from the
   * route that was built for it. An upgraded user still gets the chain, because for
   * them the chain is right.
   */
  if (await isKeylessLiteName(account)) {
    return NextResponse.json([], { headers: { 'cache-control': 'private, no-store' } });
  }
  try {
    const followers = await getFollowers({ account, start, type, limit });
    return NextResponse.json(followers, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    logger.error(error, 'followers lookup failed for %s', account);
    return NextResponse.json({ error: 'followers_unavailable' }, { status: 502 });
  }
}
