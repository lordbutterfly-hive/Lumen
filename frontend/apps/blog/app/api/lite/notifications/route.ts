import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardRead } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { requireActiveLiteUser } from '@/blog/lib/lite/http/actor';
import { listRecentFollowersWithTime } from '@/blog/lib/lite/repositories/follow-repository';
import { findUsersByIds } from '@/blog/lib/lite/repositories/user-repository';

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
  try {
    const session = await getLiteSession();
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
      if (session.user?.username === hiveParam) actor = { hive: hiveParam };
    } catch {
      /* fall through to 401 */
    }
  }
  if (!actor) return NextResponse.json({ error: 'not_signed_in' }, { status: 401 });

  try {
    const followers = await listRecentFollowersWithTime(actor as never, { limit: 30 });
    if (followers.length === 0) return NextResponse.json({ notifications: [] });

    // Resolve Lumen ids to the names those people use TODAY, so a renamed
    // account is not announced under a stale handle.
    const ids = followers.map((f) => f.userId).filter((id): id is string => !!id);
    const users = ids.length ? await findUsersByIds(ids).catch(() => []) : [];
    const nameById = new Map(users.map((u) => [u.userId, u.displayName]));

    const notifications = followers.map((f) => {
      const name = f.userId ? (nameById.get(f.userId) ?? f.userId) : (f.hive ?? 'someone');
      return {
        type: 'follow' as const,
        // Same field names the chain notification list uses, so the renderer
        // does not need a second shape to understand.
        msg: `${name} followed you`,
        url: `@${name}`,
        date: f.at,
        source: 'lumen' as const
      };
    });
    return NextResponse.json({ notifications });
  } catch (error) {
    // The bell must not break because this half failed — the chain half (for a
    // Hive account) is still worth showing.
    logger.error(error, 'lite notifications lookup failed');
    return NextResponse.json({ notifications: [], degraded: true });
  }
}
