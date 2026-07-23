import { proxifyImageSrc, isSafeImageUrl } from '@ui/components';
import type { AccountProfile } from '@hive/common-hiveio-packages/wax';

/**
 * Resolves a safe, proxified cover-image URL for the redesigned profile's
 * cover slot. Mirrors the `isSafeImageUrl` allow-list the legacy
 * `ProfileLayout` applies, but (unlike that component) returns a plain
 * `<img src>` string rather than a CSS `background-image` value — the
 * redesign renders the cover as a real `<img>` inside a rounded,
 * overflow-hidden slot, so it deliberately skips `escapeCssUrl` (that
 * helper backslash-escapes for CSS `url(...)` embedding, which would
 * corrupt a plain URL used as an `<img>` attribute).
 */
export function getCoverImageUrl(profile: AccountProfile | undefined): string {
  const coverImage = profile?.cover_image;
  if (!coverImage || !isSafeImageUrl(coverImage)) return '';
  return proxifyImageSrc(coverImage, 2048, 512).replace(/ /g, '%20');
}
