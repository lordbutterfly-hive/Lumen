import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardRead } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { requireActiveLiteUser } from '@/blog/lib/lite/http/actor';
import { listRecentFollowersWithTime } from '@/blog/lib/lite/repositories/follow-repository';
import { findUsersByIds } from '@/blog/lib/lite/repositories/user-repository';
import * as dmMessages from '@/blog/lib/lite/repositories/dm-message-repository';
import { viewerBlockedKeySet } from '@/blog/lib/lite/social/block-filter';
import { actorKey } from '@/blog/lib/lite/social/follow-actor';

const logger = getLogger('app');

/**
 * ★★★ LUMEN-NATIVE NOTIFICATIONS — currently, new followers.
 *
 * WHY THIS EXISTS (2026-08-09, tester BASELINE-03). The bell had exactly one
 * data source, `bridge.account_notifications`, which is the CHAIN. A Lumen
 * follow is never written to chain, so gaining a follower produced silence: the
 * tester followed identity A from identity B, watched the button flip to
 * "Following", and A's bell still read "No notifications yet" — before and
 * after, identically.
 *
 * That is not only a lite-account problem. A full Hive account followed by a
 * lite reader is equally invisible, because the bell cannot see Lumen at all.
 *
 * WHAT THIS DELIBERATELY IS NOT: a general notification system. Votes, reblogs
 * and replies are not here. Follows are the case the tester proved silent, they
 * are derivable from data we already keep exactly, and shipping the one real
 * thing beats a table of speculative event types nobody emits yet. When votes
 * and replies need it, they get the same treatment — read from the rows that
 * already record them, rather than a second copy that can disagree.
 *
 * "No notifications yet" is also a promise of "eventually", and for this whole
 * class of event it was false. Now it is only shown when it is true.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const blocked = guardRead();
  if (blocked) return blocked;

  // A caller may ask about a HIVE account they are signed in as; a lite caller
  // is resolved from its own session. Either way the answer is about the
  // authenticated reader — never an arbitrary name from the query string, which
  // would make one person's follower list readable by anyone.
  const hiveParam = (req.nextUrl.searchParams.get('hive') ?? '').trim().replace(/^@/, '');

  let actor: { userId?: string; hive?: string } | null = null;
  // Hoisted so the block-list lookup below can key on the SAME session that
  // established the actor, rather than re-reading the cookie.
  let sessionUser: Awaited<ReturnType<typeof getLiteSession>>['user'] | undefined;
  try {
    const session = await getLiteSession();
    sessionUser = session.user;
    const checked = await requireActiveLiteUser(session.user, session);
    if (checked.ok) actor = { userId: checked.user.userId };
    else if (hiveParam && session.user?.username === hiveParam) actor = { hive: hiveParam };
  } catch {
    actor = null;
  }
  // A full Hive session is not a lite session; trust the cookie's own username.
  if (!actor && hiveParam) {
    try {
      const session = await getLiteSession();
      sessionUser = session.user;
      if (session.user?.username === hiveParam) actor = { hive: hiveParam };
    } catch {
      /* fall through to 401 */
    }
  }
  if (!actor) return NextResponse.json({ error: 'not_signed_in' }, { status: 401 });

  try {
    const rawFollowers = await listRecentFollowersWithTime(actor as never, { limit: 30 });

    // ★ THE READER'S OWN BLOCK LIST (2026-08-23). `listRecentFollowersWithTime` already
    // drops operator-banned accounts, but not the accounts THIS reader blocked — so
    // blocking someone silenced them everywhere except the one place that announces them
    // by name, with a working link to their profile.
    //
    // ★ THE KEY IS BUILT WITH `actorKey`, NOT A HAND-WRITTEN TEMPLATE. The block set is
    // keyed `u:<userId>` / `h:<hive>`; reimplementing that here would fail SILENTLY the
    // day either side changes, because a key that never matches filters nothing and throws
    // nothing. Importing the same function the writer uses makes drift impossible.
    //
    // Degrades OPEN, like every other effect-A site: a Lumen DB hiccup must not empty
    // somebody's notification bell.
    const blockedKeys = await viewerBlockedKeySet(sessionUser).catch(() => new Set<string>());
    const followers =
      blockedKeys.size === 0
        ? rawFollowers
        : rawFollowers.filter((f) => {
            const key = f.userId
              ? actorKey({ userId: f.userId })
              : f.hive
                ? actorKey({ hive: f.hive })
                : null;
            return !key || !blockedKeys.has(key);
          });

    // No early return on empty followers: DM notifications are merged in below, so the
    // bell can carry new-message rows even for a reader with no recent followers.

    // Resolve Lumen ids to the names those people use TODAY, so a renamed
    // account is not announced under a stale handle.
    const ids = followers.map((f) => f.userId).filter((id): id is string => !!id);
    const users = ids.length ? await findUsersByIds(ids).catch(() => []) : [];
    const nameById = new Map(users.map((u) => [u.userId, u.displayName]));

    const followRows = followers.map((f) => {
      const name = f.userId ? (nameById.get(f.userId) ?? f.userId) : (f.hive ?? 'someone');
      return {
        type: 'follow' as const,
        // Same field names the chain notification list uses, so the renderer
        // does not need a second shape to understand.
        msg: `${name} followed you`,
        url: `@${name}`,
        date: f.at,
        // ★ THE FOLLOWER'S HANDLE, SENT EXPLICITLY (2026-08-16, owner: "follow
        // notifications still don't show profile pics"). The bell's Lumen rows
        // rendered as bare text while the chain rows next to them carried a
        // 40px avatar, so in one list the same event looked like two different
        // kinds of thing. The panel needs a name to draw a face from, and
        // slicing it back out of `url` or `msg` would break the moment either
        // string is reworded or translated.
        actor: name,
        source: 'lumen' as const
      };
    });

    // ── DM rows: unread incoming messages, ONE per sender (bell "New message from @X") ──
    // Content is never touched — sender + time only. Blocked senders are dropped with the
    // same key set the follow rows use, and a DM-side failure degrades open (follows still
    // show), exactly like the outer catch.
    let dmRows: Array<{ type: 'dm'; msg: string; url: string; date: string; actor?: string; source: 'lumen' }> = [];
    try {
      const myKey = actor.userId ? actorKey({ userId: actor.userId }) : actorKey({ hive: actor.hive as string });
      const senders = await dmMessages.unreadSendersForActor(myKey, 10);
      const visible =
        blockedKeys.size === 0 ? senders : senders.filter((s) => !blockedKeys.has(s.senderKey));
      const dmIds = visible.filter((s) => s.senderKey.startsWith('u:')).map((s) => s.senderKey.slice(2));
      const dmUsers = dmIds.length ? await findUsersByIds(dmIds).catch(() => []) : [];
      const dmNameById = new Map(dmUsers.map((u) => [u.userId, u.displayName]));
      dmRows = visible.map((s) => {
        const isHive = s.senderKey.startsWith('h:');
        const name = isHive ? s.senderKey.slice(2) : (dmNameById.get(s.senderKey.slice(2)) ?? null);
        return {
          type: 'dm' as const,
          msg: name ? `New message from ${isHive ? '@' : ''}${name}` : 'New message from a Lumen member',
          // The recipient's own Studio inbox — where the message is read (opening it clears
          // the unread state). Not the sender's profile, unlike a follow row.
          url: 'creators/studio?section=inbox',
          date: s.at instanceof Date ? s.at.toISOString() : String(s.at),
          // Only a Hive sender has a handle the bell can draw an avatar from; a lite sender
          // falls back to the monogram, and is named generically in `msg`.
          actor: isHive && name ? name : undefined,
          source: 'lumen' as const
        };
      });
    } catch (e) {
      logger.error(e, 'DM notifications lookup failed');
    }

    const merged = [...followRows, ...dmRows].sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    );
    return NextResponse.json({ notifications: merged });
  } catch (error) {
    // The bell must not break because this half failed — the chain half (for a
    // Hive account) is still worth showing.
    logger.error(error, 'lite notifications lookup failed');
    return NextResponse.json({ notifications: [], degraded: true });
  }
}
