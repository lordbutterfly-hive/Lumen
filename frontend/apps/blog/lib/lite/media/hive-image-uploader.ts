import { createHash } from 'crypto';
import { getLogger } from '@ui/lib/logging';
import { configuredImagesEndpoint } from '@ui/config/public-vars';
import { liteConfig } from '../config';
import { getPublisherSigner } from '../publisher/hive-broadcaster';
import { ImageUploadInput, ImageUploader, setImageUploader } from './image-host';

const logger = getLogger('app');

/**
 * The real image uploader: signs the file with the publishing account's POSTING key
 * and hands it to Hive's image host, exactly the way the browser does it for a user
 * who owns keys (`features/post-editor/lib/utils.ts` → `uploadImg`).
 *
 * The protocol, which is why this looks the way it does:
 *   digest = sha256( "ImageSigningChallenge" || <raw file bytes> )
 *   POST {host}/{account}/{signature of digest}   with the file as multipart form data
 *
 * The host verifies the signature against that account's posting authority. It is the
 * same challenge string the front end has always used — get one byte of it wrong and
 * the host answers 400 with no useful detail, so it is written out here explicitly.
 */

const CHALLENGE = 'ImageSigningChallenge';

async function signedUploadUrl(bytes: Uint8Array): Promise<string> {
  const signer = await getPublisherSigner();

  const digest = createHash('sha256')
    .update(Buffer.from(CHALLENGE, 'utf8'))
    .update(Buffer.from(bytes))
    .digest('hex');

  const signature = await signer.wallet.signDigest(signer.publicKey, digest);
  return `${configuredImagesEndpoint}/${signer.account}/${signature}`;
}

export const hiveImageUploader: ImageUploader = {
  async upload(input: ImageUploadInput): Promise<{ url: string }> {
    const url = await signedUploadUrl(input.bytes);

    const form = new FormData();
    // The host reads the filename from the form part; a Blob keeps the bytes exactly
    // as received (no re-encoding), which matters because the signature covers them.
    form.append(
      'file',
      new Blob([Buffer.from(input.bytes)], { type: input.contentType }),
      input.fileName
    );

    const res = await fetch(url, { method: 'POST', body: form });
    const text = await res.text();
    if (!res.ok) {
      // Never echo the URL: it contains the signature.
      logger.error('Image host rejected an upload: HTTP %d %s', res.status, text.slice(0, 200));
      throw new Error(`image_host_${res.status}`);
    }

    let parsed: { url?: string; error?: unknown };
    try {
      parsed = JSON.parse(text) as { url?: string };
    } catch {
      throw new Error('image_host_bad_response');
    }
    if (!parsed.url) throw new Error('image_host_no_url');
    return { url: parsed.url };
  }
};

/**
 * Install the WIF-backed uploader in DEVELOPMENT. Production refuses the env-var key
 * and must inject a KMS-backed `ImageUploader` via `setImageUploader`, the same rule
 * the broadcaster follows.
 *
 * NOTE on the mainnet guard: the publisher deliberately refuses to arm against
 * mainnet without an explicit opt-in, because a broadcast is public and permanent.
 * That reasoning does not extend here — an upload writes no chain state and creates
 * nothing anyone can find; it puts a file on a CDN. The image host is also a single
 * service with no testnet counterpart, so gating uploads on the chain would simply
 * mean lite users can never have pictures in development.
 */
export function installDevImageUploader(): boolean {
  if (!liteConfig.publisherPostingWif) return false;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'LITE_PUBLISHER_POSTING_WIF must not be used in production — inject a KMS-backed uploader via setImageUploader'
    );
  }
  setImageUploader(hiveImageUploader);
  return true;
}
