import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardRead, guardWrite } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { requireActiveLiteUser, requireLiteUser } from '@/blog/lib/lite/http/actor';
import { sanitizeProfile } from '@/blog/lib/lite/profile/profile-service';
import { updateProfile } from '@/blog/lib/lite/repositories/user-repository';

const logger = getLogger('app');

/**
 * The signed-in lite user's own profile.
 *
 * A Hive user edits their profile by broadcasting an account update; a lite user has
 * no account to update, so the same fields are stored here and rendered into the
 * account-shaped view the profile page consumes (`render/lite-account.ts`).
 */
export async function GET(): Promise<NextResponse> {
  const blocked = guardRead();
  if (blocked) return blocked;

  const session = await getLiteSession();
  // Reading your own profile is not participation — a suspended account may still
  // see what it has, the same reasoning the unfollow route uses.
  const actor = await requireLiteUser(session.user);
  if (!actor.ok) return actor.response;

  return NextResponse.json({ ok: true, profile: actor.user.profile ?? {} });
}

/** POST /api/lite/profile — replace the profile. Body is the profile object. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const blocked = guardWrite(req);
  if (blocked) return blocked;

  const session = await getLiteSession();
  const actor = await requireActiveLiteUser(session.user, session.sessionEpoch);
  if (!actor.ok) return actor.response;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

  try {
    const profile = sanitizeProfile(body.profile ?? body);
    const updated = await updateProfile(actor.user.userId, profile);
    if (!updated) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json({ ok: true, profile: updated.profile });
  } catch (error) {
    logger.error(error, 'Lite profile update failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
