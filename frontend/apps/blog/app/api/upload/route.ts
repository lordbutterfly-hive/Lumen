import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { hasCsrfHeader } from '@/blog/lib/lite/http/csrf';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { enforceHiveUploadRate } from '@/blog/lib/lite/antispam/rate-limit';
import { liteConfig } from '@/blog/lib/lite/config';
import { checkUpload, hasImageUploader, looksLikeImage, uploadImage } from '@/blog/lib/lite/media/image-host';
import { installDevImageUploader } from '@/blog/lib/lite/media/hive-image-uploader';

const logger = getLogger('app');

/**
 * ★★★ EXPLICIT: a per-viewer route that must never be cached. It reads the
 * session cookie and it writes; both make it dynamic, but saying so here means
 * it cannot be quietly prerendered the way four GET handlers in this app were
 * (see `/api/dynamic-global-properties`).
 */
export const dynamic = 'force-dynamic';

/**
 * POST /api/upload — multipart form with one `file` field. Full (keyed) accounts.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS, AND WHAT IT COSTS (owner ruling 2026-08-25: "it requires me
 * to sign with posting key just to upload an image, thats weird. fix that.")
 *
 * Hive's image host authenticates every upload with a signature over THAT FILE'S
 * BYTES — `ImageSigningChallenge` + the bytes, POSTed to `{host}/{account}/{sig}`.
 * Because the signature covers the bytes, it cannot be issued once per session
 * and reused; a keyed account therefore had to approve a wallet prompt for every
 * single image. That is the friction being removed.
 *
 * ★ THE TRADE, STATED PLAINLY. The signature still has to come from somewhere,
 * so it now comes from the PUBLISHING account, server-side — exactly what
 * `/api/lite/upload` already does for keyless accounts. Consequences:
 *   • images uploaded by a full account are attributed on Hive's side to the
 *     publisher, not to the uploading user
 *   • the server-held publisher key's remit widens from lite-only to every
 *     signed-in account
 * Both were put to the owner with the alternative (keep the prompt) and this was
 * the choice. A prior composer audit (§9.1, quoted in `use-image-upload.ts`)
 * reached the opposite conclusion — "adding a proxy would move a signed upload
 * onto our own server for no benefit" — on the grounds that the prompt was
 * acceptable. That premise is what changed; the reasoning was never wrong.
 *
 * ★ WHY NOT JUST RELAX `/api/lite/upload`. That route gates on
 * `requireActiveLiteUser`, which resolves a `lumen_user` row. A Keychain account
 * has none, so it is not a matter of loosening a check — the identity it
 * authenticates does not exist for these callers. A separate route with its own
 * gate keeps the lite path's guarantees exactly as they are.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  /* ★ CSRF ONLY — NOT `guardWrite` (adversarial review, 2026-08-25).
     `guardWrite` 503s whenever `liteConfig.enabled` is false or the lite
     Postgres is unreachable. That is the right gate for `/api/lite/*`, whose
     callers ARE lite accounts; here it would take full-account image uploads
     down whenever the unrelated lite subsystem was disabled or its database
     hiccuped. This route needs the CSRF half of that guard and nothing else —
     it touches no lite table, only the session cookie and the image host. */
  if (!hasCsrfHeader(req)) {
    return NextResponse.json({ error: 'missing_csrf_header' }, { status: 403 });
  }

  /* ★ THE GATE. `getLiteSession()` is the app's canonical session reader and is
     the ONLY thing that can assert this identity: `account_tier` lives inside
     the sealed, HMAC'd cookie payload, so a client cannot forge it. A lite
     caller is refused here rather than served — it has its own route, with its
     own quota and its own actor, and letting the two blur would give a lite
     account a second upload allowance under a different key. */
  const session = await getLiteSession();
  const user = session.user;
  if (!user?.isLoggedIn || !user.username || user.account_tier === 'lite') {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const username = user.username;

  if (!hasImageUploader()) {
    try {
      installDevImageUploader();
    } catch (error) {
      logger.error(error, 'Upload: refusing to install dev image uploader');
      return NextResponse.json({ error: 'uploader_unavailable' }, { status: 503 });
    }
  }
  if (!hasImageUploader()) {
    return NextResponse.json({ error: 'uploader_unavailable' }, { status: 503 });
  }

  /* Checked BEFORE the body is touched, for the reason the lite route documents:
     `req.formData()` buffers the whole request in memory, so validating size
     afterwards lets one account make us buffer arbitrarily large bodies. */
  const declaredLength = Number(req.headers.get('content-length') ?? '0');
  const maxBytes = liteConfig.maxUploadMb * 1024 * 1024;
  if (declaredLength > maxBytes + 1024 * 1024) {
    return NextResponse.json(
      { error: 'too_large', message: `That image is over ${liteConfig.maxUploadMb} MB.` },
      { status: 413 }
    );
  }

  /* ★ QUOTA IS NOT OPTIONAL HERE. This endpoint spends a key we hold, so an
     unmetered version would let any signed-in account use the publisher's
     identity to host unlimited files on Hive's CDN. Keyed on the Hive username,
     which cannot collide with the lite path's ULID user ids. */
  /* ★ `hive:`-PREFIXED (adversarial review, 2026-08-25). `enforceUploadRate`
     builds `user:${id}`, a namespace whose ids are lite ULIDs. Hive usernames
     cannot collide with those today (26-char uppercase Crockford vs <=16-char
     lowercase), but relying on incidental format non-overlap is not a boundary —
     and this file's own `enforceHiveFollowRate`/`enforceHiveBlockRate` already
     prefix `hive:` for exactly this reason. Same shape, explicit separation. */
  const rate = await enforceHiveUploadRate(username);
  if (!rate.ok) {
    return NextResponse.json({ error: 'rate_limited', reason: rate.reason }, { status: 429 });
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'file_required' }, { status: 400 });
  }

  const rejection = checkUpload({ size: file.size, contentType: file.type || '' });
  if (rejection) {
    return NextResponse.json({ error: rejection.code, message: rejection.message }, { status: 400 });
  }

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    /* The declared MIME is just a string in the multipart header. Sniffing the
       magic bytes is what makes "images only" true rather than advisory — an
       upload signed by the publishing account must not become a way to host
       arbitrary files under Hive's image domain. */
    if (!looksLikeImage(bytes, file.type)) {
      return NextResponse.json(
        { error: 'unsupported_type', message: 'That file is not the image type it claims to be.' },
        { status: 400 }
      );
    }
    const { url } = await uploadImage({ bytes, fileName: file.name || 'image', contentType: file.type });
    return NextResponse.json({ ok: true, url });
  } catch (error) {
    logger.error(error, 'Image upload failed');
    return NextResponse.json({ error: 'upload_failed' }, { status: 502 });
  }
}
