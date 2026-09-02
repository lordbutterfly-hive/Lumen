import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { setLoginChallengeCookies } from '@hive/smart-signer/lib/middleware-challenge-cookies';
import { logPageVisit } from './page-visit-logger';
import { buildCsp, SECURITY_HEADERS, type CspConfig } from './csp';

/**
 * Configuration options for the common middleware
 */
export interface MiddlewareConfig {
  /**
   * ★ NO COOKIE ON A SHARED-CACHEABLE PAGE (2026-09-02, snappiness phase 2).
   * When this returns true for a request, the anonymous cookies
   * (`session_uid`, the login challenge pair) are NOT minted on that
   * response. The app uses it for the anonymous pages a proxy may store: a
   * stored Set-Cookie would replay one visitor's cookies to the next, which
   * is the exact hazard the "cookie-bearing responses are never
   * shared-cacheable" rule in apps/blog/middleware.ts exists for. The first
   * API call of the visit (`/api/users/me` on every page load) still passes
   * through here without the flag and mints them.
   */
  skipCookieMinting?: (request: NextRequest) => boolean;
  /**
   * If provided, redirect root path (/) to this path
   * Example: '/trending' will redirect / to /trending
   */
  rootRedirect?: string;

  /**
   * CSP configuration for runtime evaluation
   * If provided, CSP header will be set on all responses
   */
  csp?: CspConfig;
}

/**
 * Creates a configured middleware function
 * @param config - Optional configuration for app-specific behavior
 */
export function createMiddleware(config: MiddlewareConfig = {}) {
  // Build CSP once at startup (when middleware is created), not on every request
  const cspHeader = config.csp ? buildCsp(config.csp) : null;

  return async function middleware(request: NextRequest): Promise<NextResponse> {
    const { pathname } = request.nextUrl;
    const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';

    // Handle root redirect if configured (before creating response)
    if (config.rootRedirect) {
      if (pathname === '/' || pathname === `${basePath}` || pathname === `${basePath}/`) {
        const redirectResponse = NextResponse.redirect(
          new URL(`${basePath}${config.rootRedirect}`, request.url),
          { status: 302 }
        );
        // Apply security headers to redirect responses too
        if (cspHeader) {
          redirectResponse.headers.set('Content-Security-Policy', cspHeader);
          for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
            redirectResponse.headers.set(key, value);
          }
        }
        return redirectResponse;
      }
    }

    const res = NextResponse.next();

    // Apply CSP and security headers
    if (cspHeader) {
      res.headers.set('Content-Security-Policy', cspHeader);
      for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
        res.headers.set(key, value);
      }
    }

    const mintCookies = !(config.skipCookieMinting && config.skipCookieMinting(request));
    if (mintCookies) setLoginChallengeCookies(request, res);

    // Generate session_uid for browser tracking (persists across login/logout)
    if (mintCookies && !request.cookies.has('session_uid')) {
      try {
        res.cookies.set({
          name: 'session_uid',
          value: crypto.randomUUID(),
          path: '/',
          sameSite: 'lax',
          secure: process.env.NODE_ENV === 'production',
          httpOnly: true,
          maxAge: 400 * 24 * 60 * 60 // 400 days (browser maximum)
        });
      } catch (error) {
        // Don't break middleware if UUID generation fails
      }
    }

    // ★ THIS GUARD NEVER EXCLUDED ANYTHING (fixed 2026-08-09).
    //
    // It was `pathname.match('/((?!api|_next/static|_next/image|favicon.ico).*)')`.
    // `String.prototype.match` compiles a string argument as an UNANCHORED regex, so
    // the negative lookahead only had to fail at ONE position for the match to
    // succeed somewhere else in the path. `/_next/static/chunks/app/page.js` matches
    // at `/chunks/...`; `/api/users/me` matches at `/users/me`. Every asset request
    // and every API call was therefore logged as a page visit.
    //
    // A negative lookahead like that is a Next `config.matcher` pattern, where Next
    // anchors it — it is not a substring test. The app's own middleware.ts now carries
    // it as a real matcher (which is also what stops middleware truncating >9 MiB
    // static chunks), and the intent is expressed here as an explicit prefix check.
    const isAsset =
      pathname.startsWith('/_next/') || pathname === '/favicon.ico' || pathname.startsWith('/api/');
    if (!isAsset) {
      const isPrefetch =
        request.headers.get('x-middleware-prefetch') === '1' ||
        request.headers.get('purpose') === 'prefetch' ||
        request.headers.get('sec-purpose')?.includes('prefetch');

      if (!isPrefetch) {
        logPageVisit(request, pathname);
      }
    }

    return res;
  };
}
