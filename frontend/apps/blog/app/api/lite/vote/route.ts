import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardWrite } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { requireActiveLiteUser, requireLiteUser } from '@/blog/lib/lite/http/actor';
import { enforceVoteRate } from '@/blog/lib/lite/antispam/rate-limit';
import { castVote } from '@/blog/lib/lite/repositories/engagement-repository';
import { checkEngagementTarget } from '@/blog/lib/lite/content/engagement-target';

const logger = getLogger('app');

/**
 * POST /api/lite/vote — { author, permlink, weight } (lite session).
 * Lumen-local vote (not proxied on-chain; see engagement-repository).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const blocked = guardWrite(req);
  if (blocked) return blocked;

  const session = await getLiteSession();

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const author = body?.author;
  const permlink = body?.permlink;
  const weightRaw = body?.weight;
  if (typeof author !== 'string' || typeof permlink !== 'string' || typeof weightRaw !== 'number') {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  const weight = Math.max(-10000, Math.min(10000, Math.round(weightRaw)));

  // Weight 0 clears an existing vote — a withdrawal, so a suspended account may
  // still do it (see http/actor.ts). Casting a vote is an addition and may not.
  const actor = weight === 0 ? await requireLiteUser(session.user, session.sessionEpoch) : await requireActiveLiteUser(session.user, session.sessionEpoch);
  if (!actor.ok) return actor.response;
  const user = actor.user;

  // F-L34 — a weight of 0 WITHDRAWS a vote, so it is allowed against anything
  // (including a target that has since become invalid); only ADDING engagement
  // is gated.
  if (weight !== 0) {
    const target = await checkEngagementTarget(user, author, permlink);
    if (!target.ok) {
      return NextResponse.json({ error: target.code }, { status: target.status });
    }
  }

  try {
    if (!(await enforceVoteRate(user.userId))) {
      return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
    }
    await castVote(user.userId, author, permlink, weight);
    return NextResponse.json({ ok: true, weight });
  } catch (error) {
    logger.error(error, 'Lite vote failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
