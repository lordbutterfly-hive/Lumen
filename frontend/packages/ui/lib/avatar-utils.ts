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
