import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
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
