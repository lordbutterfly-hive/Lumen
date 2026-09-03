import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { createMiddleware } from '@hive/middleware/lib/common';
import { getClientIp } from '@hive/middleware/lib/common-utils';
import { checkRequestBudget } from '@/blog/lib/request-budget';
import { anonymousCachePolicy, type CachePolicy } from '@/blog/lib/anonymous-cache-policy';
import { cookieNamePrefix } from '@hive/smart-signer/lib/session';

/**
 * ★★★ `/@user/followed` -> `/@user/following`, AS A REAL HTTP 308 (2026-08-13).
 *
 * The followers/following redesign renamed the route to the word the heading,
 * the profile stat tile and every label in the product already used. The old
 * path has been linkable for the life of the app, so it must keep resolving.
 *
 * ★ WHY THIS IS NOT JUST `permanentRedirect()` IN THE PAGE. It is that too —
 * `app/[param]/(user-profile)/followed/page.tsx` calls it, as a fallback — but
 * on its own that is NOT an HTTP redirect. Measured on the built app before
 * this was added:
 *
 *     GET /@lordbutterfly/followed  ->  HTTP 200
 *     body: <template data-dgst="NEXT_REDIRECT;replace;/@lordbutterfly/following;308;">
 *
 * The `(user-profile)` route group has a `loading.tsx`, so Next flushes the
 * shell before the page component runs; by the time `permanentRedirect` throws,
 * the status line is already sent and the redirect can only be delivered inside
 * the RSC stream for the CLIENT router to perform. A browser follows that, but
 * `curl`, a crawler, a link checker and any non-browser client see a 200 and a
 * loading skeleton. A permanent rename has to be answered before rendering.
 *
 * Doing it here rather than in `next.config.js` `redirects()` is deliberate:
 * that file is owned by another change in flight, and this middleware already
 * runs on exactly this path (see the `matcher` at the bottom of this file).
 */
const FOLLOWED_PATH = /^\/(@|%40)([a-zA-Z0-9.-]{1,16})\/followed\/?$/;

// NOTE: Nonce-based CSP is disabled because Next.js 14 doesn't fully support it.
// Next.js internal scripts (__NEXT_DATA__, hydration) don't receive nonces automatically,
// and inline style attributes (style-src-attr) don't support nonces at all.
// See GitLab issue #796 for tracking nonce CSP support in future Next.js versions.

// Blog-specific middleware: redirects root to /trending, applies CSP at runtime
/**
 * ★★★ ANONYMOUS PAGES DECLARE THEMSELVES SHARED-CACHEABLE (2026-09-02,
 * snappiness phase 2). See lib/anonymous-cache-policy.ts for what qualifies
 * and why. Two things happen for a qualifying request: no anonymous cookies
 * are minted on its response (createMiddleware's `skipCookieMinting`), and
 * the response gets an explicit `public, s-maxage=...` below, so the proxy in
 * front of Node (Caddy with the cache module) can hold it. Signed-in readers,
 * queries, the QA header and every other path keep today's behaviour.
 */
function cachePolicyFor(request: NextRequest): CachePolicy {
  return anonymousCachePolicy({
    pathname: request.nextUrl.pathname,
    method: request.method,
    // Any cookie that can personalise a render counts as a session here: the
    // sealed session itself, the client-set `observer` (read by getObserver in
    // lib/auth-utils.ts to personalise bridge reads) and `account_info`. A
    // reader carrying any of them may get a page nobody else should see, so
    // it must never be stored. The proxy mirrors this list in its bypass rule.
    hasSession:
      request.cookies.has(`${cookieNamePrefix}session`) ||
      request.cookies.has('observer') ||
      request.cookies.has('account_info'),
    hasQuery: request.nextUrl.search.length > 0,
    hasQaHeader: request.headers.has('x-lumen-qa'),
    localeCookie: request.cookies.get('NEXT_LOCALE')?.value ?? null
  });
}

const baseMiddleware = createMiddleware({
  skipCookieMinting: (request) => cachePolicyFor(request).cacheable,
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
 * ★★★ A COOKIE-BEARING RESPONSE IS NEVER SHARED-CACHEABLE — ENFORCED, NOT REMEMBERED.
 *
 * This is the FOURTH instance of the same bug in one day. `api/avatar`,
 * `api/trending-tags` and `api/streak/marks` were each found separately, each fixed by
 * adding a name to the `matcher` exclusion list below, and each time the fix was
 * written up as "the standing rule". A fourth sweep then found that nearly the whole
 * `/api/lite/*` GET surface plus `/api/feed/for-you` still answers with `Set-Cookie`
 * — including the 400-day `session_uid` — and **no `Cache-Control` header at all**.
 * Verified live, with real content: a session was minted, used to block an account,
 * and `GET /api/lite/block/list` then returned that viewer's private block list
 * carrying three `Set-Cookie` headers and no cache directive.
 *
 * An exclusion list is a memory, and memory is what kept failing. Three developers
 * remembering a rule is three chances to forget it; the next route added is the next
 * instance. So the rule stops being a list and becomes an invariant:
 *
 *   if a response sets a cookie and does not state its own cache policy,
 *   it is `private, no-store`.
 *
 * Anything that genuinely wants to be shared-cached must either say so explicitly
 * (its own `Cache-Control`, which this will not overwrite) or stay out of the
 * middleware entirely via the `matcher` — which is exactly what the three public
 * routes above already do, so they are unaffected. The failure mode is now a route
 * that is accidentally *uncacheable*, which costs a little traffic, instead of one
 * that accidentally replays one reader's session to another.
 */
/**
 * ★★★ THE REQUEST BUDGET RUNS FIRST, BEFORE THE RENAME, THE COOKIES AND THE
 * VISIT LOG (2026-09-02, snappiness phase 1). A client over budget gets a 429
 * that costs microseconds and no render. See lib/request-budget.ts for the
 * measurements: 99% of a day's requests were one crawler's, each a ~1 s render
 * on the single Node thread, and every human click queued behind them.
 * Budgeted requests are page renders, router prefetches included (Next hides the
 * flight headers from middleware, see lib/request-budget.ts); assets and API
 * routes pass untouched (that file holds the exact predicate, by known public
 * path, never by file suffix).
 */
export async function middleware(request: NextRequest): Promise<NextResponse> {
  const budget = checkRequestBudget({
    ip: getClientIp(request),
    userAgent: request.headers.get('user-agent') ?? '',
    pathname: request.nextUrl.pathname,
    qaHeader: request.headers.get('x-lumen-qa')
  });
  if (!budget.ok) {
    if (budget.shouldLog) {
      // One line per key per minute. The visit log is deliberately NOT written
      // for a refused request: it never became a page view.
      console.warn(
        `budget: 429 class=${budget.klass} key=${budget.key} path=${request.nextUrl.pathname} ua="${(
          request.headers.get('user-agent') ?? ''
        ).slice(0, 90)}"`
      );
    }
    return new NextResponse('Too many requests. Please slow down and retry shortly.\n', {
      status: 429,
      headers: {
        'retry-after': String(budget.retryAfterSeconds),
        'cache-control': 'no-store',
        'content-type': 'text/plain; charset=utf-8'
      }
    });
  }

  // The route rename, answered before anything renders — see FOLLOWED_PATH.
  // `nextUrl.clone()` carries the basePath and the query string, so a link with
  // `?foo=1` keeps it and a deployment under a basePath still lands.

  const renamed = FOLLOWED_PATH.exec(request.nextUrl.pathname);
  if (renamed) {
    const url = request.nextUrl.clone();
    url.pathname = `/@${renamed[2]}/following`;
    return NextResponse.redirect(url, 308);
  }

  const response = await baseMiddleware(request);
  const policy = cachePolicyFor(request);
  if (policy.cacheable && !response.headers.has('set-cookie')) {
    response.headers.set('cache-control', policy.cacheControl as string);
    // Read by the proxy's access log and by our checks, never by a browser.
    response.headers.set('x-lumen-cache-policy', policy.klass);
  }
  if (response.headers.has('set-cookie') && !response.headers.has('cache-control')) {
    response.headers.set('cache-control', 'private, no-store');
  }
  return response;
}

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
  // ★ `api/creator-profile` added 2026-08-30 (WORK-LINK spec B2). Same
  // reasoning as the three routes above it: it reads no cookie and no
  // session, resolves identically for every viewer, and is deliberately
  // served `public, s-maxage=300, stale-while-revalidate=3600` so a shared
  // cache can hold it — attaching this middleware would put a 400-day
  // `session_uid` Set-Cookie on that same cacheable response, replaying one
  // visitor's session to the next for up to five minutes.
  // ★ `fonts` and `images` added 2026-09-03 (CDN Phase A cutover, found live).
  // These are plain static files under `public/` — the self-hosted Lora /
  // Merriweather / Fira woff2 that every page needs, and the wallet images. They
  // read no cookie and no session, but they were NOT excluded, so this middleware
  // stamped `private, no-store` on every one of them (line 178) and minted the
  // 400-day `session_uid` Set-Cookie on each request. Measured at the edge the
  // moment Cloudflare went in front: `cf-cache-status: BYPASS` on every font —
  // the CDN's "cache if the origin says it's cacheable" rule correctly refused
  // them — and, worse, `no-store` had been defeating the BROWSER cache too, so a
  // reader re-downloaded ~120KB of fonts on every navigation, from France.
  // Excluding them stops the `no-store` + Set-Cookie; the explicit cache policy
  // for these paths lives in `next.config.js` `headers()` (public, 1 day, must-
  // revalidate by ETag — NOT `immutable`, because `/fonts` and `/images` are not
  // content-hashed, so a changed font must be able to replace itself).
  matcher: [
    '/((?!_next/static|_next/image|favicon\\.ico|fonts/|images/|api/avatar|api/trending-tags|api/streak/marks|api/creator-profile).*)'
  ]
};
