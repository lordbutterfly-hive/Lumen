import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardWrite } from '@/blog/lib/lite/http/guard';
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

  // Checked BEFORE the body is touched. `req.formData()` buffers the whole request in
  // memory, so validating size afterwards means a single free account can make us
  // buffer arbitrarily large bodies — and, because the quota used to be charged after
  // that check, do it for free, in parallel, forever.
  const declaredLength = Number(req.headers.get('content-length') ?? '0');
  const maxBytes = liteConfig.maxUploadMb * 1024 * 1024;
  // + 1 MiB of slack for multipart framing, which is not part of the file itself.
  if (declaredLength > maxBytes + 1024 * 1024) {
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
