import { NextRequest, NextResponse } from 'next/server';
import { enforceFollowListRate } from '@/blog/lib/lite/antispam/rate-limit';
import { getClientIp } from '@/blog/lib/lite/http/ip';
import { getLogger } from '@ui/lib/logging';
import { guardRead } from '@/blog/lib/lite/http/guard';
import { listFollowingPeers, listFollowerPeers } from '@/blog/lib/lite/repositories/follow-repository';
import { findUserByDisplayName, findUsersByIds } from '@/blog/lib/lite/repositories/user-repository';

const logger = getLogger('app');

/**
 * ★★★ WHO A LUMEN ACCOUNT FOLLOWS, AND WHO FOLLOWS IT.
 *
 * `GET /api/lite/follow/list?account=<name>&type=following|followers`
 *
 * The Followers/Following pages asked Hive's `condenser_api.get_following` for
 * the account being viewed. For a Lumen lite handle that account does not exist
 * on chain, so the call returned nothing and the list body stayed permanently
 * empty — directly beneath a header count that was CORRECT, because the count
 * comes from Lumen's own follow table. "1 Following" over an empty list reads as
 * a broken page, and it was the default experience for exactly the accounts this
 * product exists to onboard.
 *
 * The edges themselves span both worlds: a Lumen account can follow another
 * Lumen account (stored by `lumen_user_id`) or an ordinary Hive account (stored
 * by name). Both come back here in the shape the existing list UI already
 * renders, so nothing downstream has to learn about tiers.
 *
 * Public by design: a follower list is public on Hive and public here. No
 * session is read, and nothing is returned that the profile page does not
 * already show.
 */

const MAX_LIMIT = 100;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const blocked = guardRead();
  if (blocked) return blocked;

  // ★ PUBLIC BY DESIGN, BUT NOT UNLIMITED. Per-request size is already capped
  // at MAX_LIMIT, which bounds one answer — it does not bound how many answers
  // an anonymous caller may ask for, so the complete follower/following graph
  // of every account was scrapable at whatever rate the caller liked. Its
  // siblings `follow/state` and `block/state` already carry this exact limiter;
  // this one was simply missed. (Audit B3, L1, 2026-08-20.)
  if (!(await enforceFollowListRate(getClientIp(req)))) {
    return NextResponse.json({ ok: false, error: 'rate_limited' }, { status: 429 });
  }

  const account = req.nextUrl.searchParams.get('account')?.trim().toLowerCase();
  const type = req.nextUrl.searchParams.get('type') === 'followers' ? 'followers' : 'following';
  const limitParam = Number(req.nextUrl.searchParams.get('limit'));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, MAX_LIMIT) : 100;

  if (!account) return NextResponse.json({ error: 'account_required' }, { status: 400 });

  try {
    const user = await findUserByDisplayName(account);
    // Not a Lumen account: an empty list, not a 404. The caller asks this route
    // about every profile it renders, and most of them are ordinary Hive users
    // whose lists come from the chain instead.
    if (!user) return NextResponse.json({ entries: [], lite: false });

    const actor = { userId: user.userId };
    const peers =
      type === 'followers'
        ? await listFollowerPeers(actor, { limit })
        : await listFollowingPeers(actor, { limit });

    // One lookup for every Lumen peer on the page, not one per row. Names are
    // resolved live rather than stored on the edge, so an upgraded account's
    // followers see its NEW name (the edge deliberately records only the id).
    const ids = peers.map((p) => p.userId).filter((id): id is string => Boolean(id));
    const names = new Map(
      (await findUsersByIds([...new Set(ids)]).catch(() => [])).map((u) => [u.userId, u.displayName])
    );

    const entries = peers
      .map((p) => (p.userId ? names.get(p.userId) : p.hive))
      .filter((name): name is string => Boolean(name))
      // The shape the existing follow-list UI already renders.
      .map((name) => (type === 'followers' ? { follower: name, following: account } : { follower: account, following: name }));

    return NextResponse.json({ entries, lite: true });
  } catch (error) {
    logger.error(error, 'Lite follow list failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
