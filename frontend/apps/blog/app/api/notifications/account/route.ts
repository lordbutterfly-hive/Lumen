import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { getAccountNotifications } from '@transaction/lib/bridge-api';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { viewerBlockedKeySet } from '@/blog/lib/lite/social/block-filter';
import { hiveNamesByUserId } from '@/blog/lib/lite/social/chain-mute';
import type { IAccountNotification } from '@hive/common-hiveio-packages/wax';
import { isBannedAuthor } from '@/blog/lib/moderation/banned-authors';
import { ensureSquatterList, isSquatterName } from '@/blog/lib/lite/moderation/squatter-list';
import { reputationsFor } from '@/blog/lib/hive-reputations';

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

    /**
     * ★★★ THE BAN HAD TO REACH THE BELL (2026-09-10, owner: "i commented with
     * meritimusdoublus on a lordbutterfly post, it dissapeared but lordbutterfly got a
     * notification").
     *
     * Both halves of that are true and only one was intended. The comment is hidden
     * everywhere Lumen renders, but Hive does not know about our ban, so it still
     * raised the notification -- and this route passed it straight through. A griefer
     * therefore kept a working channel to anyone they wanted to bother: the content
     * was invisible, the ping was not, which is arguably the more annoying half.
     *
     * `notificationActor` already exists here for the per-viewer block filter and is
     * the right reader: `IAccountNotification` carries no author field, so the actor is
     * parsed out of `msg`/`url`. A bare-name check is correct on THIS surface
     * specifically -- a lite user's action never appears in a chain notification (their
     * posts are signed by the shared publisher), so an actor name here is always the
     * Hive account, which is exactly the identity the squatter list names.
     *
     * ★ The unread COUNT is a different upstream call (`bridge.unread_notifications`)
     * that returns a number with no rows to filter, so it can still exceed what the
     * panel shows. That is the pre-existing "shows 3 on the bell and there's nothing
     * inside" shape this file already documents; it needs the count derived from the
     * filtered list, which is its own change.
     */
    await ensureSquatterList();
    if (Array.isArray(filtered)) {
      filtered = filtered.filter((n) => {
        const actor = notificationActor(n);
        return !isBannedAuthor(actor) && !isSquatterName(actor);
      });
    }

    /**
     * ★★★ THE "REP" PILL NOW CARRIES A REPUTATION (2026-09-11, owner: "REP in
     * notifications is not working properly").
     *
     * The row renderer labelled `notification.score` "Rep". That field is
     * hivemind's notification IMPORTANCE score, not a reputation — a vote row is
     * scored from the vote's payout (so an ordinary vote reads 25 whoever cast
     * it) and a reply row uses a different curve than the displayed reputation.
     * See `lib/hive-reputations.ts` for the measurements. The number is resolved
     * here, on the server, in ONE batched call for the whole list, because the
     * actor is already parsed here for the two filters above.
     *
     * `rep` is ADDED, `score` is left untouched: nothing else reads it today, but
     * overwriting an upstream field with a different meaning is how the next
     * reader inherits this same bug. A row whose actor could not be resolved gets
     * no `rep` and the renderer draws no pill.
     */
    const reps = await reputationsFor(
      Array.isArray(filtered) ? filtered.map((n) => notificationActor(n)) : []
    ).catch(() => new Map<string, number>());
    const withRep = Array.isArray(filtered)
      ? filtered.map((n) => {
          const rep = reps.get(notificationActor(n).toLowerCase());
          return rep === undefined ? n : { ...n, rep };
        })
      : filtered;

    return NextResponse.json(withRep, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    logger.error(error, 'account notifications lookup failed for %s', account);
    return NextResponse.json({ error: 'account_notifications_unavailable' }, { status: 502 });
  }
}
