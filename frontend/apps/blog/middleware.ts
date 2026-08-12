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
  // ★ `api/trending-tags` added 2026-08-12, for exactly the reason above and
  // caught by an adversarial review the same day it was written. That route is
  // the global trending tag list: it reads no cookie and no session, and it is
  // deliberately served `public, s-maxage=3600, stale-while-revalidate=86400`
  // so a shared cache can hold it. With this middleware attached it was
  // answering with three `Set-Cookie` headers — including the 400-day
  // `session_uid` — on a publicly cacheable response, which is precisely the
  // replay hazard described above, at a TTL 12x longer than the avatar proxy's.
  // Verified live before the fix: `set-cookie: session_uid=...` alongside
  // `cache-control: public`.
  // ★ `api/streak/marks` added 2026-08-12. PRE-EXISTING instance of the same
  // hazard, found by a failure-state sweep and reproduced live: that route sets
  // `cache-control: public, max-age=60` (route.ts:66) while this middleware was
  // still attaching `Set-Cookie` to it, including the 400-day `session_uid`:
  //
  //   GET /api/streak/marks?users=gtg   (no cookies sent)
  //   -> set-cookie: session_uid=...; Max-Age=34560000
  //   -> cache-control: public, max-age=60
  //
  // It is not a quiet corner either: `LeagueByline` calls it from
  // `medium-post-card.tsx`, so it fires on every discovery-feed page's byline
  // batch, signed in or not. A shared cache holding that response replays one
  // visitor's session cookies to the next for the full minute.
  //
  // ★★ THE STANDING RULE, since this is now the third instance: a route that
  // sets `cache-control: public` MUST be excluded here, or it must not be
  // public. Per-viewer routes stay on the middleware and use `private, no-store`.
  matcher: [
    '/((?!_next/static|_next/image|favicon\\.ico|api/avatar|api/trending-tags|api/streak/marks).*)'
  ]
};
