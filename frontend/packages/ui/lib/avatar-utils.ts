import env from '@beam-australia/react-env';
import { configuredImagesEndpoint } from '../config/public-vars';

/**
 * Gets the base path for API routes
 * @returns The base path or empty string
 */
function getBasePath(): string {
  if (typeof window !== 'undefined') {
    return env('BASE_PATH') || '';
  }
  if (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_BASE_PATH) {
    return process.env.NEXT_PUBLIC_BASE_PATH;
  }
  return '';
}

/**
 * Builds the internal API endpoint URL for avatars
 * @param path - The API path
 * @returns Full API URL with base path if needed
 */
function getApiUrl(path: string): string {
  const basePath = getBasePath();
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${basePath}${normalizedPath}`;
}

/**
 * Get a user avatar URL using internal API endpoint (prevents caching)
 * @param username - The Hive username
 * @param size - The avatar size ('small', 'medium', 'large')
 * @returns Internal API URL for avatar
 */
export function getUserAvatarUrl(username: string, size: 'small' | 'medium' | 'large' = 'small'): string {
  return getApiUrl(`/api/avatar?username=${encodeURIComponent(username)}&size=${size}`);
}

/**
 * ★★★ THE AVATAR THAT DOES NOT GO THROUGH US (2026-08-10) — MEASURED, NOT GUESSED.
 *
 * `getUserAvatarUrl` above points every avatar at `/api/avatar`, which fetches the
 * picture from the image host and streams it back. One card does that once; a feed
 * of thirty does it twenty-nine times AT ONCE, and that is where the home page went.
 * Measured on this box, signed out, one page load:
 *   29 requests to `/api/avatar`; the 10 that finished took 6.0-6.3s EACH, and the
 *   other 19 had still not returned 45 seconds in. The same endpoint asked once on
 *   an idle server answers in 170-290ms, and the bytes are ~2 KB — so essentially
 *   all of it is queueing, not transfer. Two queues stack up: the browser allows six
 *   connections per origin, and every one of those requests then occupies the Node
 *   server (`isHiveAccountNameValid` initialises the wax WASM chain, then an upstream
 *   fetch) which serves the page's own data from the same single thread.
 *
 * The image host needs no help from us: `https://images.hive.blog/u/<name>/avatar/small`
 * answers a 302 to the real picture in ~70ms, on its own connection pool, cached by the
 * browser, and the search page already loads thumbnails from it directly.
 *
 * So this returns the host URL, and `getUserAvatarUrl` stays exactly as it was — as the
 * ERROR FALLBACK. That split is deliberate and it is what makes the switch safe: a Lumen
 * lite account has no Hive account and therefore no hosted avatar (the host answers 500),
 * and a Hive account whose stored `profile_image` points at a dead Steemit-era host 404s.
 * Both cases are exactly what the proxy handles, with the uploaded lite picture or a
 * generated initial-letter avatar. Point `src` here, point `onError` there, and the
 * common case costs us nothing while the uncommon case behaves as before.
 */
/**
 * ★ WEBP INVESTIGATED, NOT FIXABLE HERE (2026-09-04, T1b perf hunt).
 *
 * The perf hunt flagged this function alongside `/api/avatar` for serving PNG where
 * WebP would do (one profile avatar measured 473,986 bytes PNG vs 3,058 bytes WebP,
 * -99.35%), and suggested "resolve the 302 once + append &format=webp". That fix IS
 * applied in `app/api/avatar/route.ts` (it controls its own `fetch` and can follow
 * the redirect itself). It cannot be applied here, and the reason is load-bearing:
 *
 * `configuredImagesEndpoint/u/<name>/avatar/<size>` is Hive's own name->image
 * redirect shortcut. Verified against the LIVE host (curl, 2026-09-04, including
 * never-before-requested account names so this isn't a cache artifact): it ignores
 * every format-ish query param tried (`format`, `type`, `mime`, `ext`, `output`,
 * `as`, `convert`, and a plain `Accept: image/webp` header) and its `Location`
 * ALWAYS points at a plain, source-format `/p/<hash>?width=&height=` URL — getting
 * WebP requires a second request to that resolved URL with `format=webp` added.
 * peakd.com and ecency.com hit this exact same bare shortcut with no format/size
 * param either, which is corroborating evidence this is a platform limitation, not
 * something fixable by asking differently.
 *
 * This function is a synchronous string builder with no network access, called
 * directly as an `<img src>` by `packages/ui/components/user-avatar-img.tsx` — the
 * WHOLE POINT of this code path (see the block comment above) is that resolving
 * anything server-side is exactly the queueing bug it exists to avoid. Making this
 * WebP-aware would mean either (a) this function performing the resolve itself,
 * which needs `async`/a second fetch and breaks its only caller's synchronous
 * `src={getUserAvatarDirectUrl(...)}` usage, or (b) routing it back through OUR
 * origin to do that resolving, i.e. reverting the exact fix the comment above
 * describes. Both are out of this function's reach without editing
 * `user-avatar-img.tsx` (out of scope for this change) or reintroducing the
 * queueing regression. Flagged as residual risk rather than papered over with a
 * `?format=webp` that would be a no-op on the live host.
 */
export function getUserAvatarDirectUrl(
  username: string,
  size: 'small' | 'medium' | 'large' = 'small'
): string {
  return `${configuredImagesEndpoint}/u/${encodeURIComponent(username)}/avatar/${size}`;
}

/**
 * Get a user avatar URL with specific dimensions using internal API endpoint (prevents caching)
 * @param username - The Hive username
 * @param width - Image width
 * @param height - Image height
 * @returns Internal API URL for avatar with dimensions
 */
export function getUserAvatarUrlWithDimensions(username: string, width: number, height: number): string {
  return getApiUrl(`/api/avatar?username=${encodeURIComponent(username)}&width=${width}&height=${height}`);
}

/**
 * Get the default fallback image URL using internal API endpoint (prevents caching)
 * @returns Internal API URL for default avatar
 */
export function getDefaultImageUrl(): string {
  return getApiUrl('/api/avatar/default');
}
