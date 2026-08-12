import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { getFollowList } from '@transaction/lib/bridge-api';
import { FollowListType } from '@hive/common-hiveio-packages/wax';

const logger = getLogger('app');

const VALID_TYPES: readonly FollowListType[] = ['follow_blacklist', 'follow_muted', 'blacklisted', 'muted'];

/**
 * ★ THROUGH OUR SERVER, NOT THE CHAIN CLIENT (2026-08-12). `bridge.get_follow_list`
 * is the one read behind `use-follow-list.tsx`'s `useFollowListQuery` that ~33
 * sibling reads already had a route for and this one did not — it called
 * `getFollowList` directly, which reaches `getChain()` and downloads
 * `wax.common.wasm` (2.34 MB).
 *
 * Three independent call sites, all client components: `useModerationStatus`
 * (the blacklist read behind the profile header's "..." menu and the post/
 * comment overflow menus — feeds `medium-post-card.tsx`, `profile-main.tsx`,
 * `profile-actions.tsx`), the post page's comment-thread mute read
 * (`content.tsx`), and the legacy `PostList`'s blacklist read
 * (`posts-loader.tsx`). Fixing the one hook fixes all three.
 *
 * NOT CACHED and NOT `public`: a mute/blacklist list is per-viewer moderation
 * data — a shared cache holding this response would hand one reader's list to
 * another.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const observer = (req.nextUrl.searchParams.get('observer') ?? '').trim().toLowerCase();
  const type = (req.nextUrl.searchParams.get('type') ?? '') as FollowListType;
  if (!/^[a-z][a-z0-9.-]{1,15}$/.test(observer)) {
    return NextResponse.json({ error: 'observer_required' }, { status: 400 });
  }
  if (!VALID_TYPES.includes(type)) {
    return NextResponse.json({ error: 'type_required' }, { status: 400 });
  }
  try {
    const list = await getFollowList(observer, type);
    return NextResponse.json(list, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    logger.error(error, 'follow list lookup failed for %s (%s)', observer, type);
    // A real status, not a fake empty list: `use-moderation-status.ts`'s
    // `muteStatusUnknown`/`blacklistStatusUnknown` and `content.tsx`'s
    // `mutedListIsError` all depend on this failing loudly rather than
    // resolving as "confirmed nobody is muted/blacklisted".
    return NextResponse.json({ error: 'follow_list_unavailable' }, { status: 502 });
  }
}
