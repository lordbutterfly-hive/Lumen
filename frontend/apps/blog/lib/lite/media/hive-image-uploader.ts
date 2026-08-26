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
    /* ★★★ HONOURS THE SAME OPT-IN AS THE PUBLISHER (2026-08-25, owner-reported:
       lite image uploads were 503 on every production build).

       This used to throw unconditionally in production — "inject a KMS-backed
       uploader" — with no escape hatch at all. Nothing in this repo injects one,
       so the practical effect was that `/api/lite/upload` answered 503 forever
       and **keyless accounts could not attach an image at all**. The keyed
       accounts' new `/api/upload` proxy hit the same wall.

       That was an INCONSISTENCY, not a policy. `installWifBroadcaster`
       (`lib/lite/publisher/hive-broadcaster.ts:306-324`) faces the identical
       question about the identical key and answers it with an explicit,
       loudly-warned opt-in: `LITE_PUBLISHER_ALLOW_WIF_IN_PROD=yes`. The operator
       has already set that flag. Uploading an image is also strictly LESS
       consequential than what that flag already permits — the publisher writes
       permanent posts to a public ledger with this key; this puts a picture on
       Hive's free, shared image CDN.

       So: same flag, same refusal when it is absent, same warning when it is
       present. One decision about one key, not two subsystems disagreeing. */
    if (process.env.LITE_PUBLISHER_ALLOW_WIF_IN_PROD !== 'yes') {
      throw new Error(
        'Refusing to arm the WIF image uploader in production. Nothing in this repo ' +
          'injects a KMS-backed uploader, so leaving this unset means every image upload ' +
          'answers 503 and no account — lite or keyed — can attach a picture. Set ' +
          'LITE_PUBLISHER_ALLOW_WIF_IN_PROD=yes to run on the raw posting key (the same ' +
          'flag the publisher uses, revocable on Hive with one account_update), or inject ' +
          'a real signer via setImageUploader.'
      );
    }
    logger.warn(
      'lite image uploader: ARMED IN PRODUCTION WITH A RAW POSTING WIF ' +
        '(LITE_PUBLISHER_ALLOW_WIF_IN_PROD=yes). Images are signed by, and attributed to, ' +
        'the publishing account. Replace with a KMS-backed uploader via setImageUploader, ' +
        'and rotate the publisher posting authority if this key is ever exposed.'
    );
  }
  setImageUploader(hiveImageUploader);
  return true;
}
