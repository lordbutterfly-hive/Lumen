import { createMiddleware } from '@hive/middleware/lib/common';

// NOTE: Nonce-based CSP is disabled because Next.js 14 doesn't fully support it.
// Next.js internal scripts (__NEXT_DATA__, hydration) don't receive nonces automatically,
// and inline style attributes (style-src-attr) don't support nonces at all.
// See GitLab issue #796 for tracking nonce CSP support in future Next.js versions.

// Blog-specific middleware: redirects root to /trending, applies CSP at runtime
export const middleware = createMiddleware({
  // rootRedirect removed for the rebuild: '/' now renders the discovery home.
  // The legacy trending feed still lives at /trending.
  csp: {
    // Embedded content whitelist for blog posts
    // Note: 3speak.online/co removed (compromised/spam), code normalizes to 3speak.tv
    // Note: emb.d.tube removed (subdomain down, no renderer support)
    frameSrc: [
      'https://platform.twitter.com',
      'https://www.instagram.com',
      'https://player.vimeo.com',
      'https://www.youtube.com',
      'https://w.soundcloud.com',
      'https://player.twitch.tv',
      'https://open.spotify.com',
      'https://3speak.tv',
      'https://odysee.com'
    ],
    reportUri: '/api/csp-report'
  }
});

/**
 * ★★ STATIC ASSETS MUST NOT ENTER MIDDLEWARE — IT TRUNCATES THEM (2026-08-09).
 *
 * Without a `matcher`, Next runs middleware on EVERY request, including
 * `/_next/static/**`. `createMiddleware` then calls `NextResponse.next()` and mutates
 * headers on the asset's response, and the Edge runtime buffers it — so any chunk
 * larger than ~9 MiB is delivered truncated while still advertising its full length.
 *
 * Measured, not theorised:
 *
 *   GET /_next/static/chunks/app/%5Bparam%5D/(user-profile)/page.js
 *     Content-Length: 20601288      (matches the file on disk)
 *     bytes delivered:  9437184     (exactly 9 MiB)
 *     browser:          net::ERR_CONTENT_LENGTH_MISMATCH
 *
 * The consequence is not subtle: that chunk is the profile page, so `/@user` served a
 * 200, rendered its SSR HTML, and then **never hydrated** — it sat on
 * `profile-main-skeleton` forever. Same for `app/layout.js`. It is also a large share
 * of why the Playwright e2e suite fails: a client-rendered assertion cannot pass on a
 * page whose JavaScript never arrived.
 *
 * `common.ts` clearly INTENDED to skip these — it carries the exact same negative
 * lookahead inline — but as `pathname.match(<string>)` it is unanchored and matches
 * anywhere, so it excluded nothing. Here it is in the one place Next anchors it.
 *
 * ★ `/api` IS DELIBERATELY STILL IN SCOPE. The documented Next example also excludes
 * it, and the inline guard named it too, but middleware sets the login-challenge
 * cookies and `session_uid` on every request — dropping API routes out of middleware
 * would change auth-cookie behaviour, which is not what this fix is for. Only static
 * assets are excluded: the smallest change that stops the truncation.
 */
export const config = {
  /**
   * ★ /api/avatar IS EXCLUDED, AND THIS IS A SECURITY FIX, NOT A PERF ONE (2026-08-11).
   *
   * This middleware mints fresh `session_uid` / `app_login_challenge` cookies on any
   * request that arrives without them, so a `Set-Cookie` rode along on every avatar
   * response. That was inert while the route sent `no-store`. It stopped being inert
   * the moment the route was given `public, max-age=60` for caching: a shared cache
   * or CDN in front of production can store a response WITH its Set-Cookie and replay
   * one visitor's session cookie to the next visitor inside the TTL.
   *
   * The avatar proxy needs nothing this middleware provides: it is keyed entirely on
   * the username/size query params and never reads a cookie or a session. Excluding
   * it keeps the cache win and removes the header that made caching unsafe.
   */
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico|api/avatar).*)']
};
