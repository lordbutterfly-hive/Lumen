import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardModerator } from '@/blog/lib/lite/http/guard';
import { moderateUser, UserAction } from '@/blog/lib/lite/moderation/moderation-service';
import { findUserByDisplayName } from '@/blog/lib/lite/repositories/user-repository';

const logger = getLogger('app');

const ACTIONS: UserAction[] = ['suspend', 'ban', 'reinstate'];

/**
 * POST /api/lite/moderation/user — suspend, ban, or reinstate a lite account.
 *
 * Token-guarded (`x-lite-moderator-token`), not session-guarded: there is no admin
 * account model, and a shared operator secret is honest about that rather than
 * inventing a half-role system that looks like authorisation but is not.
 *
 * Accepts a display name as well as a user id, because an operator acting on a
 * report has a name in front of them, not a ULID.
 *
 * Body: { userId | displayName, action, reason?, hideContent?, actor? }
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const blocked = guardModerator(req);
  if (blocked) return blocked;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const action = body?.action;
  if (typeof action !== 'string' || !ACTIONS.includes(action as UserAction)) {
    return NextResponse.json({ error: 'invalid_action', allowed: ACTIONS }, { status: 400 });
  }

  let userId = typeof body?.userId === 'string' ? body.userId : '';
  if (!userId && typeof body?.displayName === 'string') {
    const user = await findUserByDisplayName(body.displayName.trim().toLowerCase());
    if (!user) return NextResponse.json({ error: 'user_not_found' }, { status: 404 });
    userId = user.userId;
  }
  if (!userId) return NextResponse.json({ error: 'user_required' }, { status: 400 });

  const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
  // A moderation action nobody can explain later is not a moderation action, and the
  // one moment the reason is actually known is now.
  if (action !== 'reinstate' && !reason) {
    return NextResponse.json({ error: 'reason_required' }, { status: 400 });
  }

  try {
    const result = await moderateUser({
      actor: actorOf(req, body),
      userId,
      action: action as UserAction,
      reason: reason || null,
      hideContent: body?.hideContent === true
    });
    if (!result) return NextResponse.json({ error: 'user_not_found' }, { status: 404 });

    return NextResponse.json({
      status: 'ok',
      user: {
        userId: result.user.userId,
        displayName: result.user.displayName,
        status: result.user.status,
        suspendedReason: result.user.suspendedReason
      },
      jobsHeld: result.jobsHeld,
      jobsReleased: result.jobsReleased,
      postsHidden: result.postsHidden,
      postsRestored: result.postsRestored,
      postsOnChain: result.postsOnChain,
      // Said out loud on every response: Lumen can hide, Hive cannot forget.
      note:
        result.postsOnChain > 0
          ? `${result.postsOnChain} of this account's posts are already on Hive and are NOT removed by this action — use the post takedown for each.`
          : undefined
    });
  } catch (error) {
    logger.error(error, 'Moderation (user) failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

/**
 * Who did it, from the HEADER the operator's tooling sets — never the request body
 * (F-L14). A body-supplied actor let any moderator-token holder attribute an action to
 * someone else. `_body` is kept for call-site symmetry but deliberately ignored. True
 * per-operator identity stays a product decision (one shared token, no admin model yet).
 */
function actorOf(req: NextRequest, _body: Record<string, unknown> | null): string {
  return req.headers.get('x-lite-moderator-actor')?.trim() || 'operator';
}
