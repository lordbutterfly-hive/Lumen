import { NextRequest, NextResponse } from 'next/server';
import { configuredImagesEndpoint } from '@hive/ui/config/public-vars';
import { proxifyImageSrc } from '@hive/ui/lib/proxify-images';
// ★ Deliberately NOT `from '@hive/transaction'`. That barrel's index.ts also
// pulls in `getSigner`, whose module graph statically imports the password
// dialog/form components for the hbauth, google-drive and wif signers (real
// UI, needed so a browser can prompt for a key). This route is a pure Node
// Route Handler with no React tree, so none of that is reachable at runtime
// here — but Next's SERVER webpack build still resolves `react-hook-form`
// from inside that graph under the `react-server` export condition, which
// only exposes `{ appendErrors, get, set }` (see the package's
// `dist/react-server.esm.mjs`), not `useForm`. That produced a build-time
// "'useForm' is not exported from 'react-hook-form'" warning with an import
// trace running straight through this file. Importing the validator
// directly from its own submodule (already an established pattern — see
// `@transaction/lib/chain` in packages/smart-signer/lib/signer/*.ts) skips
// the barrel, and with it the signer/UI stack this route never needed.
import { isHiveAccountNameValid } from '@transaction/lib/validate-hive-account';
import { withRetry } from '@transaction/lib/retry';
import { liteAvatar } from '@/blog/lib/lite/render/lite-identity';

/**
 * Proxy endpoint for user avatars.
 * Usage: /api/avatar?username=USERNAME&size=small|medium|large
 *        /api/avatar?username=USERNAME&width=WIDTH&height=HEIGHT
 *
 * ★★★ CACHED NOW (2026-08-11). The response is a pure function of the query
 * params — `username` (+ `size`/`width`/`height`) resolve to the SAME image
 * for every visitor; nothing here reads a cookie, session or the requester's
 * identity (liteAvatar() looks up the NAMED account from the DB, not the
 * caller). `no-store` was previously blanket-applied with no route-specific
 * reasoning in the comment it replaced ("prevents caching"), and it was
 * costing real time: measured 29 avatar requests per page load on comment
 * threads/profiles/witnesses/proposals/wallet at 6.0-6.3s each under load,
 * vs ~300ms direct. A short public TTL lets the same avatar survive
 * client-side navigation instead of re-fetching every time.
 *
 * One caveat for whoever owns this next: `middleware.ts` sets fresh,
 * per-request `session_uid`/`app_login_challenge` cookies on EVERY request
 * that reaches this route (measured — two cookie-less curls 2s apart got two
 * different UUIDs), and those `Set-Cookie` headers ride along on this
 * response today. That is harmless for the browser's own cache (a visitor's
 * cache never serves another visitor), but if this ever sits behind a
 * SHARED cache (a CDN, a reverse proxy) in production, a cached response
 * could in principle replay one visitor's session cookie to another within
 * the 60s window. Not a reason to keep `no-store` — this deployment is
 * origin-only today — but worth knowing before putting a CDN in front of it.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const searchParams = req.nextUrl.searchParams;
    const username = searchParams.get('username');
    const size = searchParams.get('size');
    const width = searchParams.get('width');
    const height = searchParams.get('height');

    if (!username) {
      return NextResponse.json({ error: 'Username is required' }, { status: 400 });
    }

    if (!(await isHiveAccountNameValid(username))) {
      return NextResponse.json({ error: 'Invalid username' }, { status: 400 });
    }

    // Build the image hoster URL
    let imageUrl: string;
    if (size && ['small', 'medium', 'large'].includes(size)) {
      imageUrl = `${configuredImagesEndpoint}/u/${username}/avatar/${size}`;
    } else if (width && height) {
      const baseUrl = `${configuredImagesEndpoint}/u/${username}/avatar`;
      imageUrl = baseUrl;
    } else {
      imageUrl = `${configuredImagesEndpoint}/u/${username}/avatar/small`;
    }

    // Fetch the image from the image hoster and stream it to the client.
    // ★ WEBP (2026-09-04, T1b perf). `imageUrl` above is Hive's own
    // `/u/<name>/avatar/<size>` shortcut — verified (curl, 2026-09-04, including
    // never-before-requested account names so this isn't a cache artifact, and
    // cross-checked against peakd.com's and ecency.com's own production markup,
    // which hit this exact same bare shortcut) to IGNORE every format-ish query
    // param it's given (`format`, `type`, `mime`, `ext`, `output`, `as`,
    // `convert`, plain `Accept: image/webp`) and always 302 to a plain,
    // source-format `/p/<hash>?width=&height=` URL. That target DOES honour
    // `format` once you're looking at it directly — one 512x512 avatar measured
    // 84,121 bytes PNG vs 6,570 bytes WebP (-92%) — so `fetchAsWebp` resolves
    // that one redirect itself and re-requests the resolved URL with
    // `format=webp` set, instead of trusting the shortcut's own Location.
    // `fetch`'s normal redirect-follow already cost this exact same 2 network
    // hops, so this is not a slower request, just a smarter second one.
    const response = await fetchAsWebp(imageUrl, `avatar(${username})`);

    if (!response.ok || !response.body) {
      // A Lumen lite account has no Hive account and therefore no hosted avatar, so
      // the image hoster 404s and every surface that renders this as a bare
      // background-image showed a blank square. Serve a generated initial-letter
      // avatar instead — the same idea as the feed strip's AvatarFallback, but here so
      // that every consumer of /api/avatar benefits without touching each one.
      const lite = await liteAvatar(username);
      if (lite.isLite) {
        // A picture the user uploaded through /api/lite/upload. It already lives on
        // the same image host, so hand it back through the host's resizer to keep
        // avatars a consistent size instead of shipping a full-resolution photo to
        // every byline.
        if (lite.imageUrl) {
          // ★ WEBP (2026-09-04, T1b perf). Unlike the Hive-account branch above, we
          // already HAVE the source URL here — no redirect to resolve, so this goes
          // straight through `proxifyImageSrc`, the same resize/format proxy every
          // other image in the app uses, instead of hand-building the legacy
          // `/{w}x{h}/<url>` path and hoping the origin picks a small format on its
          // own (verified 2026-09-04: it does not — that path 301s to the same
          // `/p/<hash>` proxy and needs `format` set explicitly, exactly like the
          // shortcut above).
          const { width: boxWidth, height: boxHeight } = avatarBox(size, width, height);
          // Narrow once into a const: the `if (lite.imageUrl)` narrowing above is
          // NOT preserved for the property access inside the `() =>` fetch closures
          // below (TS re-widens a property to `string | null` across a closure), so
          // capture the checked value as a `string` const the closures can use.
          const imageUrl = lite.imageUrl;
          const picture = await withRetry(
            () => fetch(proxifyImageSrc(imageUrl, boxWidth, boxHeight), { headers: { 'User-Agent': 'Mozilla/5.0' } }),
            { label: `avatar-resized(${username})` }
          );
          // WebP isn't guaranteed for every stored source — fall back to the proxy's
          // own default (source) format rather than turning that into a broken avatar.
          const resolved =
            picture.ok && picture.body
              ? picture
              : await withRetry(
                  () => fetch(proxifyImageSrc(imageUrl, boxWidth, boxHeight, 'match'), { headers: { 'User-Agent': 'Mozilla/5.0' } }),
                  { label: `avatar-resized-fallback(${username})` }
                );
          if (resolved.ok && resolved.body) {
            return new NextResponse(resolved.body, {
              status: 200,
              headers: new Headers({
                'Content-Type': resolved.headers.get('content-type') || 'image/png',
                'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
                // ★ 60s -> 1 day + a 7-day revalidate window (2026-08-13). Measured: the
                // post page makes 14 separate /api/avatar calls at 700-737ms each, and at
                // max-age=60 every one of them came back a minute later on the next page.
                // An avatar is the most static thing on a byline; when someone does change
                // theirs, stale-while-revalidate serves the old one once and refreshes
                // behind it, so the cost of the longer life is one stale render, not a
                // broken one.
                'X-Content-Type-Options': 'nosniff'
              })
            });
          }
          // Fall through: a broken stored URL must not leave the byline blank.
        }
        return initialAvatar(username);
      }
      // ★ AND THE SAME FOR A HIVE ACCOUNT WHOSE STORED PICTURE IS DEAD.
      //
      // The reasoning above applies identically here and the code stopped one
      // branch short: a JSON error body is not an image, so every consumer that
      // renders this as a bare `background-image` — the search results, bylines,
      // hover cards — showed a blank circle. Measured 2026-08-06:
      // `/api/avatar?username=akatsuki28121997` -> 400, because that account's
      // on-chain `profile_image` points at a Steemit-era host that no longer
      // exists. That is not an unusual account; it is what a meaningful share of
      // eight years of Hive history looks like.
      return initialAvatar(username);
    }

    // Prepare headers, copying content-type from the origin
    const headers = new Headers({
      'Content-Type': response.headers.get('content-type') || 'image/png',
      // Same 1-day life as the lite branch above, and for the same reason.
      'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
      'X-Content-Type-Options': 'nosniff',
    });

    // Stream the response body directly
    return new NextResponse(response.body, {
      status: 200,
      headers,
    });
  } catch (error) {
    console.error('Error fetching avatar:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}


/**
 * Pixel box for the image host's resizer, matching the size names the rest of the app
 * asks for (`small`/`medium`/`large` are the host's own avatar presets). Returns numbers
 * (not a `"WxH"` string) so callers can hand them straight to `proxifyImageSrc`.
 */
function avatarBox(size: string | null, width: string | null, height: string | null): { width: number; height: number } {
  if (width && height) {
    const w = Math.min(Math.max(Number(width) || 128, 16), 1024);
    const h = Math.min(Math.max(Number(height) || 128, 16), 1024);
    return { width: w, height: h };
  }
  if (size === 'large') return { width: 512, height: 512 };
  if (size === 'medium') return { width: 256, height: 256 };
  return { width: 128, height: 128 };
}

/**
 * ★ WEBP RESOLVER (2026-09-04, T1b perf). `shortcutUrl` is Hive's own
 * `/u/<name>/avatar/<size>` redirect — it ignores every format param on the request
 * (verified) and always 302s to a plain, source-format `/p/<hash>?width=&height=` URL.
 * That resolved URL DOES honour `format`, so this follows the ONE redirect itself
 * (`redirect: 'manual'`, which — unlike a browser's cross-origin fetch — gives a real
 * status/Location here since this runs server-side with no CORS restriction) and
 * re-requests it with `format=webp` set.
 *
 * Falls back to exactly the un-modified resolved URL — i.e. today's PNG behaviour —
 * if the WebP-forced request fails, so a source the proxy can't transcode still
 * resolves to a real picture instead of a broken avatar. If `shortcutUrl` doesn't
 * redirect at all (missing account, upstream error), the probe response is handed
 * back untouched so the caller's existing `!response.ok` fallback logic runs exactly
 * as it did before this change.
 */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

async function fetchAsWebp(shortcutUrl: string, label: string): Promise<Response> {
  const probe = await withRetry(
    () => fetch(shortcutUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'manual' }),
    { label: `${label}-probe` }
  );

  const location = probe.headers.get('location');
  if (!REDIRECT_STATUSES.has(probe.status) || !location) {
    return probe;
  }

  const original = new URL(location, shortcutUrl);
  const asWebp = new URL(original);
  asWebp.searchParams.set('format', 'webp');

  const webp = await withRetry(() => fetch(asWebp.toString(), { headers: { 'User-Agent': 'Mozilla/5.0' } }), { label });
  if (webp.ok && webp.body) {
    return webp;
  }

  return withRetry(() => fetch(original.toString(), { headers: { 'User-Agent': 'Mozilla/5.0' } }), { label: `${label}-fallback` });
}

/**
 * Deterministic initial-letter avatar. Same name always yields the same colour, so a
 * user's avatar does not change between page loads.
 */
function initialAvatar(username: string): NextResponse {
  const letter = (username.trim()[0] ?? '?').toUpperCase();
  let hash = 0;
  for (const ch of username) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96" role="img" aria-label="${letter}">
  <rect width="96" height="96" fill="hsl(${hash} 45% 42%)"/>
  <text x="48" y="62" text-anchor="middle" font-family="system-ui,sans-serif" font-size="46" font-weight="600" fill="#fff">${letter}</text>
</svg>`;
  return new NextResponse(svg, {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml',
      // Cacheable: it is a pure function of the name.
      'Cache-Control': 'public, max-age=86400'
    }
  });
}
