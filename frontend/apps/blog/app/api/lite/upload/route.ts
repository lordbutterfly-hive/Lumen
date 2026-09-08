import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardWrite, readBoundedBytes } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { requireActiveLiteUser } from '@/blog/lib/lite/http/actor';
import { enforceUploadRate } from '@/blog/lib/lite/antispam/rate-limit';
import { liteConfig } from '@/blog/lib/lite/config';
import { checkUpload, hasImageUploader, looksLikeImage, uploadImage } from '@/blog/lib/lite/media/image-host';
import { installDevImageUploader } from '@/blog/lib/lite/media/hive-image-uploader';

const logger = getLogger('app');

/**
 * POST /api/lite/upload — multipart form with one `file` field.
 *
 * Image hosting for keyless accounts. The browser cannot sign the upload (a lite
 * account has no key), so the file is handed here and signed by the publishing
 * account before going to Hive's image host. Returns `{ url }`, which the caller
 * drops into post markdown or saves as a profile picture.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const blocked = guardWrite(req);
  if (blocked) return blocked;

  const session = await getLiteSession();
  const actor = await requireActiveLiteUser(session.user, session);
  if (!actor.ok) return actor.response;
  const user = actor.user;

  // Dev convenience, same shape as the publisher drain: wire the env-var signer if
  // one is configured. Production injects a KMS-backed uploader at boot instead.
  if (!hasImageUploader()) {
    try {
      installDevImageUploader();
    } catch (error) {
      logger.error(error, 'Lite upload: refusing to install dev image uploader');
      return NextResponse.json({ error: 'uploader_unavailable' }, { status: 503 });
    }
  }
  if (!hasImageUploader()) {
    return NextResponse.json({ error: 'uploader_unavailable' }, { status: 503 });
  }

  // ★ STREAM-BOUNDED, NOT HEADER-BOUNDED (FIX-DOS, 2026-09-08 — DOS-09).
  // The old guard trusted a caller-optional `content-length`; a chunked/streamed
  // request simply omits it (`declaredLength` computes to 0, never `>` the cap), and
  // `req.formData()` then buffered the whole body regardless of its real size —
  // measured: a 40 MiB body with no content-length -> 79.2 MiB RSS growth, vs 0.00 MiB
  // for the identical body honestly declared. `readBoundedBytes` counts bytes AS it
  // reads and cancels the instant the cap is exceeded, so an oversized body is never
  // fully buffered — the limit now bounds ALLOCATION, not just a header value.
  const maxBytes = liteConfig.maxUploadMb * 1024 * 1024;
  // + 1 MiB of slack for multipart framing, which is not part of the file itself —
  // unchanged from the original header-based cap.
  const bytes = await readBoundedBytes(req, maxBytes + 1024 * 1024);
  if (bytes === null) {
    return NextResponse.json(
      { error: 'too_large', message: `That image is over ${liteConfig.maxUploadMb} MB.` },
      { status: 413 }
    );
  }

  // Charged before anything expensive: the cost being protected is the work this
  // request causes, and a failed upload causes it just the same.
  const rate = await enforceUploadRate(user.userId);
  if (!rate.ok) {
    return NextResponse.json({ error: 'rate_limited', reason: rate.reason }, { status: 429 });
  }

  // `readBoundedBytes` already fully consumed the original request's body stream, so
  // `req.formData()` on `req` itself would throw ("body already used"). Re-parse the
  // SAME bytes we already hold and bounded, carrying the original multipart
  // Content-Type header across (the boundary lives there, not in the body).
  const contentType = req.headers.get('content-type') ?? '';
  const form = await new Request('http://internal.invalid/upload', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: bytes
  })
    .formData()
    .catch(() => null);
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
    // The declared MIME is just a string in the multipart header. Sniffing the magic
    // bytes is what makes "images only" true rather than advisory — an upload signed
    // by the publishing account must not become a way to host arbitrary files under
    // Hive's image domain.
    if (!looksLikeImage(bytes, file.type)) {
      return NextResponse.json(
        { error: 'unsupported_type', message: 'That file is not the image type it claims to be.' },
        { status: 400 }
      );
    }
    const { url } = await uploadImage({
      bytes,
      fileName: file.name || 'image',
      contentType: file.type
    });
    return NextResponse.json({ ok: true, url });
  } catch (error) {
    logger.error(error, 'Lite image upload failed');
    return NextResponse.json({ error: 'upload_failed' }, { status: 502 });
  }
}
