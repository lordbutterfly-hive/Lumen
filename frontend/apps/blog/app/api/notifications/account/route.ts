import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { getAccountNotifications } from '@transaction/lib/bridge-api';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { viewerBlockedKeySet } from '@/blog/lib/lite/social/block-filter';
import { hiveNamesByUserId } from '@/blog/lib/lite/social/chain-mute';
import type { IAccountNotification } from '@hive/common-hiveio-packages/wax';

const logger = getLogger('app');

/**
 * Who a notification is ABOUT — duplicated from `notificationActor` in
 * `@transaction/lib/bridge-api.ts` (a private, unexported const there, used for
 * the operator ban-list filter) rather than imported, because that module is a
 * shared package outside `lib/lite` and every other block-enforcement primitive
 * in this codebase deliberately lives at the route/lib/lite layer, never in a
 * shared package (see `block-filter.ts`'s own header: "none of them ship a
 * block list to the client"). Same regexes, same reasoning: `IAccountNotification`
 * has no author field, so the actor is read out of the human-readable `msg`
 * ("@troll replied to your post") or, failing that, `url`
 * ("hive-125125/@troll/permlink").
 */
function notificationActor(n: IAccountNotification): string {
  const fromMsg = /^@([a-z0-9.-]{3,16})\b/.exec(n?.msg ?? '')?.[1];
  if (fromMsg) return fromMsg;
  return /@([a-z0-9.-]{3,16})\//.exec(n?.url ?? '')?.[1] ?? '';
}

/**
 * ★ Same rule as `/api/notifications/unread`, for the full notification LIST
 * rather than just the unread count. Three separate browser call sites called
 * `getAccountNotifications` directly: the header bell's popover
 * (`notifications-menu.tsx`, opened by any signed-in reader), the home-feed
 * retention nudge (`retention-nudge.tsx`, which also duplicated
 * `getUnreadNotifications` instead of reusing the header's fixed fetch — see
 * that component), and `community-layout.tsx` (a community's own activity,
 * for every visitor to that community — not gated on being signed in). Each
 * reaches `getChain()` and downloads `wax.common.wasm`.
 *
 * NOT CACHED, NOT `public`: this is one account's notification stream, and
 * the community-activity use is per-community but still not something a
 * shared cache should hold across the header's per-reader use of the same
 * route.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const account = (req.nextUrl.searchParams.get('account') ?? '').trim().toLowerCase();
  const lastIdParam = req.nextUrl.searchParams.get('lastId');
  const limitParam = req.nextUrl.searchParams.get('limit');
  if (!/^[a-z0-9][a-z0-9.-]{1,31}$/.test(account)) {
    return NextResponse.json({ error: 'account_required' }, { status: 400 });
  }
  const lastId = lastIdParam ? Number(lastIdParam) : null;
  // A garbage `limit` must not turn into an unbounded upstream request.
  const limit = limitParam && Number.isFinite(Number(limitParam)) ? Math.min(Number(limitParam), 100) : 50;
  try {
    const notifications = await getAccountNotifications(account, Number.isFinite(lastId) ? lastId : null, limit);

    // ★★★ EFFECT (A) — THE VIEWER'S OWN BLOCK LIST (RENDER-06 fix, 2026-09-08).
    //
    // This is the CHAIN half of the header bell popover; its sibling,
    // `/api/lite/notifications` (the Lumen-native half of the SAME popover),
    // already applies `viewerBlockedKeySet` to its follow/DM rows. This half had
    // zero session/block dependency at all, so a Hive account the viewer had
    // blocked (or muted on PeakD — see `chain-mute.ts`, folded into the same
    // set) kept ringing the bell by name, with a working permalink back to
    // their profile, forever.
    //
    // ★ `account` HERE IS THE NOTIFICATION FEED'S OWNER (the header bell's own
    // account, or — per the doc comment above — a community being viewed by
    // ANY visitor, signed in or not). The VIEWER whose block list applies is
    // whoever is actually making this request, resolved from the session, same
    // as every other effect-A site. For the header-bell use this is normally
    // the same person; for the community-activity use it lets even an
    // anonymous visitor's (empty) block list resolve safely to a no-op.
    //
    // ★ DEGRADES OPEN: a Lumen DB hiccup or an anonymous caller must not turn
    // into a 502 or an empty bell — same posture as every other effect-A site.
    let sessionUser: Awaited<ReturnType<typeof getLiteSession>>['user'] | undefined;
    try {
      sessionUser = (await getLiteSession()).user;
    } catch {
      sessionUser = undefined;
    }
    const blockedKeys = await viewerBlockedKeySet(sessionUser).catch(() => new Set<string>());

    let filtered = notifications;
    if (blockedKeys.size > 0 && Array.isArray(notifications) && notifications.length > 0) {
      // The block set is keyed `u:<userId>`/`h:<hiveName>`; a chain notification
      // actor is always a bare Hive account name, so `u:` keys (an upgraded
      // Lumen account the viewer blocked before or after they linked a Hive
      // name) need one resolving lookup, batched for the whole list.
      const hiveKeys = new Set<string>();
      const userIds: string[] = [];
      for (const key of blockedKeys) {
        if (key.startsWith('h:')) hiveKeys.add(key.slice(2));
        else if (key.startsWith('u:')) userIds.push(key.slice(2));
      }
      if (userIds.length > 0) {
        const resolved = await hiveNamesByUserId(userIds).catch(() => new Map<string, string>());
        for (const name of resolved.values()) hiveKeys.add(name);
      }
      filtered =
        hiveKeys.size === 0
          ? notifications
          : notifications.filter((n) => {
              const actor = notificationActor(n).toLowerCase();
              return !actor || !hiveKeys.has(actor);
            });
    }

    return NextResponse.json(filtered, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    logger.error(error, 'account notifications lookup failed for %s', account);
    return NextResponse.json({ error: 'account_notifications_unavailable' }, { status: 502 });
  }
}
