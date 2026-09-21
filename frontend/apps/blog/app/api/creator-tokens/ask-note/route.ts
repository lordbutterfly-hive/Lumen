import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardRead, guardWrite, guardBodySize } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { requireActiveLiteUser } from '@/blog/lib/lite/http/actor';
import { listByUser } from '@/blog/lib/lite/repositories/credential-repository';
import { walletDid } from '@/blog/lib/lite/wallet/did-pkh';
import { notesFor, putAskNote } from '@/blog/lib/lite/repositories/ask-note-repository';
import { askReferenceOf, contractKeyOf, isAskReference, noteTextProblem, parseReferenceList } from '@/blog/lib/meritum/ask-note';

const logger = getLogger('app');

/**
 * ★★★ THE MESSAGE A BUYER ATTACHES TO A REQUEST (2026-09-21, owner's QA list 3.2/3.3:
 * "I left a message with the order. The creator did not see it").
 *
 * The contract carries ONE free-form field per escrow, `contentHash`, bounded and
 * pipe-free, and the client fills it with `askReference(text)`: a short fingerprint
 * of what the buyer typed. The text itself went nowhere. So a creator opened a
 * request and found "Reference ask-14woy0" where the brief should have been, and
 * the buyer's message was lost the moment the dialog closed.
 *
 * This table keeps the text, keyed by the SAME fingerprint the chain holds. That
 * is what makes it honest rather than a second, disputable copy: a note is only
 * accepted when `askReferenceOf(text)` equals the `contentHash` it is filed under,
 * so anyone holding the escrow record can check that the text they are reading is
 * the text the reference was minted from. Nothing settles against it. The chain
 * is still the record of the payment; this is the record of the ask.
 *
 * WHO MAY READ. The two parties and nobody else: a row is returned only when the
 * session's own contract keys include the creator it was sent to OR the asker who
 * wrote it. Same identity discriminator as /api/lite/notifications and the
 * offering-description route: a full Hive session is `hive:<username>` (proven by
 * signature at login); a lite session owns the `did:pkh` of its bound wallets, and
 * its display name is never trusted as a Hive account.
 */

/** Every contract key this session may act as. Empty = not signed in (or refused). */
async function sessionKeys(): Promise<Set<string>> {
  const keys = new Set<string>();
  const session = await getLiteSession();
  const u = session.user;
  if (!u) return keys;
  const isLiteActor = !!u.userId || u.account_tier === 'lite';
  if (isLiteActor) {
    const checked = await requireActiveLiteUser(u, session);
    if (!checked.ok) return keys;
    for (const c of await listByUser(checked.user.userId)) {
      const did = walletDid(c.method, c.externalRef, c.network);
      if (did) keys.add(did);
    }
    return keys;
  }
  if (u.username) keys.add(contractKeyOf(u.username));
  return keys;
}

/** The two parties' notes for one creator's escrows, looked up by reference. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const blocked = guardRead();
  if (blocked) return blocked;
  const creator = contractKeyOf(req.nextUrl.searchParams.get('creator') ?? '');
  if (creator === 'hive:') return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  // References that are not the client's `ask-...` shape can never have a note
  // (nothing is filed under them), so they are dropped rather than refused: an
  // inbox holding one must read "no message was attached", not "couldn't load".
  const hashes = parseReferenceList(req.nextUrl.searchParams.get('hashes'));
  if (hashes.length === 0) {
    return NextResponse.json({ notes: {} }, { headers: { 'cache-control': 'private, no-store' } });
  }
  let mine: Set<string>;
  try {
    mine = await sessionKeys();
  } catch (error) {
    logger.error(error, 'ask note: identity lookup failed');
    return NextResponse.json({ error: 'identity_unavailable' }, { status: 503 });
  }
  if (mine.size === 0) return NextResponse.json({ error: 'not_signed_in' }, { status: 401 });
  try {
    const rows = await notesFor(creator, hashes);
    const notes: Record<string, { text: string; asker: string; createdAt: string }> = {};
    for (const r of rows) {
      if (!mine.has(r.creator) && !mine.has(r.asker)) continue;
      notes[r.contentHash] = { text: r.text, asker: r.asker, createdAt: r.createdAt };
    }
    return NextResponse.json({ notes }, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    // Degrades OPEN with a flag: an inbox without its messages is still an inbox,
    // but the reader must be told the messages could not be read, not that none exist.
    logger.error(error, 'ask note read failed for %s', creator);
    return NextResponse.json({ notes: {}, unavailable: true }, { headers: { 'cache-control': 'private, no-store' } });
  }
}

/** The buyer files the text behind the reference they just put on chain. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const blocked = guardWrite(req) ?? guardBodySize(req);
  if (blocked) return blocked;
  let body: { creator?: unknown; contentHash?: unknown; asker?: unknown; text?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'bad_json' }, { status: 400 });
  }
  const creator = contractKeyOf(typeof body.creator === 'string' ? body.creator : '');
  const contentHash = typeof body.contentHash === 'string' ? body.contentHash.trim() : '';
  const asker = contractKeyOf(typeof body.asker === 'string' ? body.asker : '');
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (creator === 'hive:' || asker === 'hive:' || !isAskReference(contentHash)) {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }
  const problem = noteTextProblem(text);
  if (problem) return NextResponse.json({ error: 'bad_text', message: problem }, { status: 400 });
  // The reference on chain must be the fingerprint of THIS text, or the note is
  // not the brief the escrow was opened with. Refused here, before any identity
  // work, because it is the cheapest check and the one that matters most.
  if (askReferenceOf(text) !== contentHash) {
    return NextResponse.json({ error: 'reference_mismatch' }, { status: 400 });
  }
  let mine: Set<string>;
  try {
    mine = await sessionKeys();
  } catch (error) {
    logger.error(error, 'ask note: identity lookup failed');
    return NextResponse.json({ error: 'identity_unavailable' }, { status: 503 });
  }
  if (mine.size === 0) return NextResponse.json({ error: 'not_signed_in' }, { status: 401 });
  if (!mine.has(asker)) return NextResponse.json({ error: 'not_your_key' }, { status: 403 });
  try {
    const stored = await putAskNote({ creator, contentHash, asker, text });
    // A row filed by a DIFFERENT asker under the same reference is left alone; the
    // caller is told so rather than silently losing their message.
    if (!stored) return NextResponse.json({ error: 'taken' }, { status: 409 });
  } catch (error) {
    logger.error(error, 'ask note write failed for %s/%s', creator, contentHash);
    return NextResponse.json({ error: 'write_failed' }, { status: 502 });
  }
  return NextResponse.json({ ok: true }, { status: 201, headers: { 'cache-control': 'private, no-store' } });
}
