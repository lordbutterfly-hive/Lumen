import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardRead, guardWrite } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { requireActiveLiteUser } from '@/blog/lib/lite/http/actor';
import { setInterests } from '@/blog/lib/lite/repositories/user-repository';
import {
  INTERESTS,
  MAX_INTERESTS,
  MIN_INTERESTS,
  sanitizeInterestIds
} from '@/blog/lib/lite/interests/taxonomy';

const logger = getLogger('app');

/**
 * GET  /api/lite/interests — the taxonomy plus this account's current picks.
 * POST /api/lite/interests — { interests: string[] } save the picks.
 *
 * ★ WHY THIS EXISTS. recsys has accepted `explicit_interest_tags` since it was
 * built and NOTHING ever supplied them, so a fresh lite account reached the
 * ranker with no follows, no interests and no history — measured 2026-08-06:
 * every result came back `popular_fallback`. The engine was correct; the product
 * never asked the question.
 */
export async function GET(): Promise<NextResponse> {
  const blocked = guardRead();
  if (blocked) return blocked;

  let selected: string[] = [];
  let asked = false;
  try {
    const session = await getLiteSession();
    const actor = await requireActiveLiteUser(session.user, session.sessionEpoch);
    if (actor.ok) {
      selected = actor.user.interests ?? [];
      asked = actor.user.interestsSetAt !== null;
    }
  } catch {
    /* logged out — still serve the taxonomy so the picker can render */
  }

  // The client shows the picker on `!asked`, NEVER on "selected is empty" —
  // otherwise anyone who deliberately skipped is asked again every login.
  return NextResponse.json({
    interests: INTERESTS,
    selected,
    asked,
    max: MAX_INTERESTS,
    min: MIN_INTERESTS
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const blocked = guardWrite(req);
  if (blocked) return blocked;

  const session = await getLiteSession();
  const actor = await requireActiveLiteUser(session.user, session.sessionEpoch);
  if (!actor.ok) return actor.response;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  // Sanitized against the taxonomy, capped, de-duplicated: picks are
  // client-supplied and a tag the taxonomy does not define has no business
  // reaching the ranker.
  const picks = sanitizeInterestIds(body?.interests);

  try {
    const updated = await setInterests(actor.user.userId, picks);
    if (!updated) return NextResponse.json({ error: 'user_not_found' }, { status: 404 });
    return NextResponse.json({ status: 'ok', selected: updated.interests });
  } catch (error) {
    logger.error(error, 'Saving lite interests failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
