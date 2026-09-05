import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardRead, guardWrite, guardBodySize } from '@/blog/lib/lite/http/guard';
import { getClientIp } from '@/blog/lib/lite/http/ip';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { enforceDmKeyLookupRate } from '@/blog/lib/lite/antispam/rate-limit';
import { lookupPublicKey, registerOwnKey } from '@/blog/lib/lite/dm/dm-service';

const logger = getLogger('app');

/**
 * The DM public-key registry. Public keys ONLY ever pass through here — the private key
 * is generated in and never leaves the browser (migration 0018 doctrine, extended to
 * messaging by 0040).
 *
 * GET  /api/lite/dm/keys?actor=<handle>  -> { public_key, key_version } | { public_key: null }
 *        Public: a public key is public. Returns null (200) when the identity has not
 *        registered one yet, so the compose UI can show an honest "not set up yet".
 * POST /api/lite/dm/keys { publicKey }   -> register/rotate the CALLER'S OWN key (authed).
 *        The actor is the session, never a client claim.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const blocked = guardRead();
  if (blocked) return blocked;

  // Resolving an unknown name fans out to Hive; its own per-IP bucket, not the signup
  // funnel's, bounds enumeration and that amplification.
  if (!(await enforceDmKeyLookupRate(getClientIp(req)))) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  const actor = req.nextUrl.searchParams.get('actor')?.trim();
  if (!actor) return NextResponse.json({ error: 'actor_required' }, { status: 400 });

  try {
    const key = await lookupPublicKey(actor);
    if (!key) return NextResponse.json({ public_key: null });
    return NextResponse.json({ public_key: key.publicKey, key_version: key.keyVersion });
  } catch (error) {
    logger.error(error, 'DM key lookup failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const blocked = guardWrite(req);
  if (blocked) return blocked;

  const tooBig = guardBodySize(req);
  if (tooBig) return tooBig;

  const session = await getLiteSession();
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;

  try {
    const result = await registerOwnKey(session.user, session, body?.publicKey);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ ok: true, public_key: result.publicKey, key_version: result.keyVersion });
  } catch (error) {
    logger.error(error, 'DM key registration failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
