import { NextRequest, NextResponse } from 'next/server';
import { enforceFollowListRate } from '@/blog/lib/lite/antispam/rate-limit';
import { getClientIp } from '@/blog/lib/lite/http/ip';
import { getLogger } from '@ui/lib/logging';
import { guardRead } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { listFollowingPeers, listFollowerPeers } from '@/blog/lib/lite/repositories/follow-repository';
import { findUsersByIds } from '@/blog/lib/lite/repositories/user-repository';
import { findLiteUserByPublicName } from '@/blog/lib/lite/render/public-name';
import { viewerBlockedKeySet } from '@/blog/lib/lite/social/block-filter';
import { actorKey } from '@/blog/lib/lite/social/follow-actor';

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
 * session is REQUIRED, and nothing is returned that the profile page does not
 * already show.
 *
 * ★★★ EXCEPT the VIEWER's OWN blocked accounts (RENDER-07 fix, 2026-09-08).
 * "Public" describes who may ask this route about whose list; it never meant
 * that a viewer who blocked someone should still be shown that person's name,
 * with a working link to their profile, on the one page dedicated to listing
 * names. Every comparable identity surface in this app already drops a
 * viewer's own blocks (`/api/account-posts`, `/api/lite/notifications`'s
 * follow rows, the search people-results, the suggestions rail) — this route
 * was the omission, not an intentional exception. A session is now read, but
 * stays OPTIONAL: an anonymous caller (or a signed-in viewer who blocks
 * nobody) gets the exact same, fully public response as before.
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
    // ★ GUARDED: see lib/lite/render/public-name.ts.
    const user = await findLiteUserByPublicName(account);
    // Not a Lumen account: an empty list, not a 404. The caller asks this route
    // about every profile it renders, and most of them are ordinary Hive users
    // whose lists come from the chain instead.
    if (!user) return NextResponse.json({ entries: [], lite: false });

    const actor = { userId: user.userId };
    const rawPeers =
      type === 'followers'
        ? await listFollowerPeers(actor, { limit })
        : await listFollowingPeers(actor, { limit });

    // ★★★ THE VIEWER'S OWN BLOCK LIST (RENDER-07 fix, 2026-09-08). See the GET
    // doc comment above: this list stays public for anyone to REQUEST, but a
    // signed-in viewer must never be shown a name they blocked in it. No
    // session is required to reach this route at all, so a failed/absent
    // session simply resolves to an empty block set (identical to the prior,
    // fully-unfiltered behaviour) rather than a 401.
    let sessionUser: Awaited<ReturnType<typeof getLiteSession>>['user'] | undefined;
    try {
      sessionUser = (await getLiteSession()).user;
    } catch {
      sessionUser = undefined;
    }
    const blockedKeys = await viewerBlockedKeySet(sessionUser).catch(() => new Set<string>());
    const peers =
      blockedKeys.size === 0
        ? rawPeers
        : rawPeers.filter((p) => {
            const key = p.userId ? actorKey({ userId: p.userId }) : p.hive ? actorKey({ hive: p.hive }) : null;
            return !key || !blockedKeys.has(key);
          });

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
