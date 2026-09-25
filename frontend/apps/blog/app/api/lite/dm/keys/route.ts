import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardRead, guardWrite, guardBodySize } from '@/blog/lib/lite/http/guard';
import { getClientIp } from '@/blog/lib/lite/http/ip';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { enforceDmKeyLookupRate } from '@/blog/lib/lite/antispam/rate-limit';
import { getOwnKey, lookupPublicKey, lookupPublicKeyAtVersion, registerOwnKey } from '@/blog/lib/lite/dm/dm-service';

const logger = getLogger('app');

/**
 * The DM public-key registry. Public keys ONLY ever pass through here — the private key
 * is generated in and never leaves the browser (migration 0018 doctrine, extended to
 * messaging by 0040).
 *
 * GET  /api/lite/dm/keys?actor=<handle>  -> { public_key, key_version } | { public_key: null }
 *        Public: a public key is public. Returns null (200) when the identity has not
 *        registered one yet, so the compose UI can show an honest "not set up yet".
 *        With `&version=<n>`: that earlier version instead, for reading old messages.
 * POST /api/lite/dm/keys { publicKey, backup? } -> register/rotate the CALLER'S OWN key
 *        (authed). The actor is the session, never a client claim. `backup` is the private
 *        key already encrypted in the browser (see migration 0052); stored verbatim.
 * GET  /api/lite/dm/keys?own=1           -> the CALLER'S OWN current key and its backup
 *        (authed), so a device without the key can restore it: { public_key, key_version,
 *        backup } | { public_key: null }.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const blocked = guardRead();
  if (blocked) return blocked;

  // The caller's own key + backup: authed, no name to resolve and no Hive call, so it
  // does not spend the lookup bucket below.
  if (req.nextUrl.searchParams.get('own') === '1') {
    const session = await getLiteSession();
    try {
      const own = await getOwnKey(session.user, session);
      if (!own.ok) return NextResponse.json({ error: own.error }, { status: own.status });
      if (!own.key) return NextResponse.json({ public_key: null });
      return NextResponse.json({ public_key: own.key.publicKey, key_version: own.key.keyVersion, backup: own.key.backup });
    } catch (error) {
      logger.error(error, 'DM own key read failed');
      return NextResponse.json({ error: 'server_error' }, { status: 500 });
    }
  }

  // Resolving an unknown name fans out to Hive; its own per-IP bucket, not the signup
  // funnel's, bounds enumeration and that amplification.
  if (!(await enforceDmKeyLookupRate(getClientIp(req)))) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  const actor = req.nextUrl.searchParams.get('actor')?.trim();
  if (!actor) return NextResponse.json({ error: 'actor_required' }, { status: 400 });

  const versionParam = req.nextUrl.searchParams.get('version');
  const version = versionParam === null ? null : Number(versionParam);
  if (version !== null && !(Number.isInteger(version) && version >= 1)) {
    return NextResponse.json({ error: 'invalid_version' }, { status: 400 });
  }

  try {
    const key = version === null ? await lookupPublicKey(actor) : await lookupPublicKeyAtVersion(actor, version);
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
    const result = await registerOwnKey(session.user, session, body?.publicKey, body?.backup, body?.startOver === true);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ ok: true, public_key: result.publicKey, key_version: result.keyVersion });
  } catch (error) {
    logger.error(error, 'DM key registration failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
