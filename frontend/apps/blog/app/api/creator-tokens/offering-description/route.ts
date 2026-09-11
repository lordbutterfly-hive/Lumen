import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardRead, guardWrite, guardBodySize } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { requireActiveLiteUser } from '@/blog/lib/lite/http/actor';
import { listByUser } from '@/blog/lib/lite/repositories/credential-repository';
import { walletDid } from '@/blog/lib/lite/wallet/did-pkh';
import {
  descriptionProblem,
  descriptionsForCreator,
  setOfferingDescription
} from '@/blog/lib/lite/repositories/offering-description-repository';

const logger = getLogger('app');

/**
 * ★★★ THE LONG DESCRIPTION FOR A POSTED SERVICE.
 *
 * The contract gives an offering ONE free-form buyer-facing string, the title,
 * bounded at 64 BYTES, and charges ~41 RC per byte of it. So the title carries the
 * identity and the price everywhere a short label is what is wanted, and this
 * carries the prose on the ONE surface that has room for it: the service list on a
 * creator's token page, whose renderer has had an empty `desc` slot since it was
 * built (live/adapt.ts set `desc: ''` rather than fabricate one).
 *
 * Migration `0045_offering_descriptions.sql` carries the why-not-on-chain argument.
 */

/** The creator key as the contract stores it: a Hive name, or a full `did:pkh:…`. */
function readCreator(raw: string | null): string {
  return (raw ?? '').trim().replace(/^@/, '');
}

/**
 * Every creator key the SESSION may write under.
 *
 * A full Hive session owns its `username` and only its own: that name is proven by
 * signature at login. A lite session owns whatever `did:pkh` its bound wallets
 * produce, because that DID is what registered the market (use-live-studio.ts's
 * `creatorAccount`, and the 2026-08-23 note there on a Studio keyed to the display
 * name finding nothing). A lite session's `username` is a self-chosen display name
 * and is NEVER trusted as a Hive account — the same discriminator `/api/lite/
 * notifications` uses, for the same reason: a display name can collide with a real
 * Hive account.
 */
async function writableCreatorKeys(): Promise<Set<string>> {
  const keys = new Set<string>();
  const session = await getLiteSession();
  const u = session.user;
  if (!u) return keys;
  const isLiteActor = !!u.userId || u.account_tier === 'lite';
  if (isLiteActor) {
    const checked = await requireActiveLiteUser(u, session);
    if (!checked.ok) return keys; // a refused lite session is signed out here
    for (const c of await listByUser(checked.user.userId)) {
      const did = walletDid(c.method, c.externalRef, c.network);
      if (did) keys.add(did);
    }
    return keys;
  }
  if (u.username) keys.add(u.username);
  return keys;
}

/** Public: the descriptions for one creator's shop, for the token page. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const blocked = guardRead();
  if (blocked) return blocked;
  const creator = readCreator(req.nextUrl.searchParams.get('creator'));
  if (!creator) return NextResponse.json({ error: 'creator_required' }, { status: 400 });
  const map = await descriptionsForCreator(creator);
  // Public and identical for every viewer, so it may be cached at the edge — but
  // briefly: a creator who fixes a typo should not read their own stale prose for
  // minutes. `stale-while-revalidate` keeps the shop instant either way.
  return NextResponse.json(
    { descriptions: Object.fromEntries(map) },
    { headers: { 'cache-control': 'public, max-age=30, stale-while-revalidate=120' } }
  );
}

/** The creator, writing their own. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const blocked = guardWrite(req) ?? guardBodySize(req);
  if (blocked) return blocked;

  let body: { creator?: unknown; offeringId?: unknown; description?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'bad_json' }, { status: 400 });
  }

  const creator = readCreator(typeof body.creator === 'string' ? body.creator : null);
  const offeringId = Number(body.offeringId);
  const description = typeof body.description === 'string' ? body.description : '';
  if (!creator || !Number.isInteger(offeringId) || offeringId < 0) {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  const problem = descriptionProblem(description);
  if (problem) return NextResponse.json({ error: 'too_long', message: problem }, { status: 400 });

  let allowed: Set<string>;
  try {
    allowed = await writableCreatorKeys();
  } catch (error) {
    // Unlike every READ in this codebase, an auth lookup must NOT degrade open:
    // failing to establish who someone is can never mean "let them write".
    logger.error(error, 'offering description: identity lookup failed');
    return NextResponse.json({ error: 'identity_unavailable' }, { status: 503 });
  }
  if (allowed.size === 0) return NextResponse.json({ error: 'not_signed_in' }, { status: 401 });
  if (!allowed.has(creator)) return NextResponse.json({ error: 'not_your_market' }, { status: 403 });

  try {
    await setOfferingDescription(creator, offeringId, description);
  } catch (error) {
    logger.error(error, 'offering description write failed for %s/%s', creator, offeringId);
    return NextResponse.json({ error: 'write_failed' }, { status: 502 });
  }
  return NextResponse.json({ ok: true }, { headers: { 'cache-control': 'private, no-store' } });
}
