import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { isKeylessLiteName } from '@/blog/lib/lite/render/lite-identity';
import { cachedRead } from '@/blog/lib/server-read-cache';
import { getFollowing } from '@transaction/lib/hive-api';

const logger = getLogger('app');

/**
 * ★ Same rule as `/api/account`. `features/account-lists/hooks/use-
 * following-infinitequery.tsx` (backing `/[param]/followed`, the mute/block
 * lists, the discovery-feed's own-following check, and every author hover-
 * card's Follow/Mute button state) called `getFollowing` directly — one of
 * the most widely-used reads in the app.
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
   * Two failures, one cause. For an uncontested lite name `get_following` threw
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
    // ★ MEMOISED (2026-08-13): measured firing four times on one profile view.
    // A follow list is public chain data for `account`, identical whoever asks, so
    // one upstream read serves the burst. See lib/server-read-cache.ts.
    const following = await cachedRead(
      `following:${account}:${type}:${start}:${limit}`,
      15_000,
      () => getFollowing({ account, start, type, limit })
    );
    return NextResponse.json(following, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    // ★ A LITE ACCOUNT FOLLOWS NOBODY ON HIVE, AND THAT IS AN ANSWER
    // (2026-08-15, same fix as /api/notifications/unread). A Lumen handle has no
    // chain account, so `getFollowing` asserts `Account <name> does not exist`.
    // Answering 502 made every profile view of a lite reader emit a red failed
    // request for a question whose true answer is "an empty list". Anything else
    // still 502s, so a genuinely broken chain stays loud.
    const message = error instanceof Error ? error.message : String(error);
    if (/Account .* does not exist/i.test(message)) {
      logger.info('following: %s has no chain account (lite) — answering an empty list', account);
      return NextResponse.json([], { headers: { 'cache-control': 'private, no-store' } });
    }
    logger.error(error, 'following lookup failed for %s', account);
    return NextResponse.json({ error: 'following_unavailable' }, { status: 502 });
  }
}
