import { liteConfig } from '../config';

/**
 * Image hosting for keyless (lite) accounts.
 *
 * Hive's own image host (`images.hive.blog`, the `imagehoster` service) is free and
 * already the store this app uses for every other upload — so a lite user's pictures
 * go there too rather than into storage we would have to build and pay for. The
 * catch is that the host authenticates uploads: it wants the file signed by a Hive
 * account's posting key, and a lite account has no key of any kind.
 *
 * So the upload is signed SERVER-SIDE by the same publishing account that broadcasts
 * lite posts. That is the identity Hive already sees behind this content, which makes
 * it the honest one to use here as well.
 *
 * Uploaded URLs are content-addressed and served to anyone, so nothing about the
 * signing account limits who can read the image afterwards.
 *
 * Injection seam, matching `publisher/broadcaster.ts`: production supplies a
 * KMS-backed implementation, development installs the WIF-based one from
 * `hive-image-uploader.ts`.
 */

export interface ImageUploadInput {
  bytes: Uint8Array;
  fileName: string;
  contentType: string;
}

export interface ImageUploader {
  upload(input: ImageUploadInput): Promise<{ url: string }>;
}

let uploader: ImageUploader | null = null;

export function setImageUploader(next: ImageUploader): void {
  uploader = next;
}

export function hasImageUploader(): boolean {
  return uploader !== null;
}

export async function uploadImage(input: ImageUploadInput): Promise<{ url: string }> {
  if (!uploader) {
    throw new Error('No image uploader installed — call setImageUploader() at bootstrap');
  }
  return uploader.upload(input);
}

/**
 * What the image host will actually store. Kept narrow on purpose: these are the
 * formats a browser renders inline, and an upload signed by the publishing account
 * should not be a way to host arbitrary files under Hive's image domain.
 */
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/**
 * Do the first bytes agree with the declared type?
 *
 * The multipart content-type is written by the client and means nothing on its own.
 * These four signatures are the formats we accept; anything else is refused before the
 * publishing account signs it.
 */
export function looksLikeImage(bytes: Uint8Array, declaredType: string): boolean {
  const at = (i: number) => bytes[i] ?? -1;
  const ascii = (start: number, text: string) =>
    [...text].every((ch, i) => at(start + i) === ch.charCodeAt(0));

  const jpeg = at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff;
  const png = at(0) === 0x89 && ascii(1, 'PNG');
  const gif = ascii(0, 'GIF8');
  const webp = ascii(0, 'RIFF') && ascii(8, 'WEBP');

  switch (declaredType.toLowerCase()) {
    case 'image/jpeg':
      return jpeg;
    case 'image/png':
      return png;
    case 'image/gif':
      return gif;
    case 'image/webp':
      return webp;
    default:
      return false;
  }
}

export type UploadRejection = { code: 'unsupported_type' | 'too_large' | 'empty'; message: string };

export function checkUpload(input: {
  size: number;
  contentType: string;
}): UploadRejection | null {
  if (input.size <= 0) return { code: 'empty', message: 'That file is empty.' };
  if (!ALLOWED_TYPES.has(input.contentType.toLowerCase())) {
    return { code: 'unsupported_type', message: 'Images only — JPEG, PNG, GIF or WebP.' };
  }
  const maxBytes = liteConfig.maxUploadMb * 1024 * 1024;
  if (input.size > maxBytes) {
    return { code: 'too_large', message: `That image is over ${liteConfig.maxUploadMb} MB.` };
  }
  return null;
}
