/**
 * ★★★ WHICH ANONYMOUS PAGES A SHARED CACHE MAY HOLD, AND FOR HOW LONG
 * (2026-09-02, snappiness phase 2). Pure and edge-safe; called from the
 * middleware, unit-tested on its own.
 *
 * WHY. Every page on this site answered `private, no-store`, so the proxy in
 * front of Node could absorb nothing: each visit, human or crawler, was a
 * ~250 ms (home) to ~1,000 ms (profile) render on the single Node thread
 * (measured, see SNAPPINESS-AUDIT-2026-09-02 sections 2 and 12). Ecency's
 * anonymous home comes from an edge cache at ~85 ms TTFB; ours cannot be
 * cached until it says it may.
 *
 * WHAT MAY BE CACHED. Only a page a signed-OUT reader would see, and only
 * when nothing about the request could make two readers' pages differ:
 *   - GET, no session cookie (`app_session`; the lite session shares it),
 *   - no query string (a query is a different page, or a personal one),
 *   - no QA bypass header (our checks must see the origin),
 *   - a path in the list below. Everything else keeps its default policy.
 * The locale cookie (`NEXT_LOCALE`) DOES change the page, so the proxy keys
 * on it; that is Caddy's side (see the Caddyfile), not this file's.
 *
 * WHAT MUST HOLD FOR THIS TO BE SAFE. A response the proxy stores must carry
 * no Set-Cookie (the middleware skips minting the anonymous cookies exactly
 * when this says cacheable; the first API call of the visit mints them
 * instead) and no personal content. Both are checked by the staging run,
 * not assumed.
 *
 * TTLs. `s-maxage` is for the shared cache only; `max-age=0` keeps browsers
 * revalidating. `stale-while-revalidate` lets the proxy answer instantly and
 * refresh behind the reader. Home turns over in minutes, profiles and posts
 * in hours; the follower lists are the crawlers' favourite and change least.
 * The home and topic windows are deliberately short (worst case ~90 s and
 * ~3 min old): the feed seed baked into the page carries `initialDataUpdatedAt`
 * and the client never refetches it on its own (found in review), so the page's
 * age IS the feed's age for that reader.
 */

export interface CachePolicyInput {
  pathname: string;
  method: string;
  hasSession: boolean;
  hasQuery: boolean;
  hasQaHeader: boolean;
  /**
   * The NEXT_LOCALE cookie value, if any. Only the nine exact codes the app
   * ships are cacheable; any other spelling (`pl-PL`, `%61r`, upper case) is
   * honoured by the app's i18n but cannot be keyed safely by a proxy, so the
   * response must stay private (found in review round 2, on the live edge:
   * the proxy already bypasses these, this is the app's own guarantee).
   */
  localeCookie?: string | null;
}

export const CACHEABLE_LOCALES = new Set(['ar', 'en', 'es', 'fr', 'it', 'ja', 'pl', 'ru', 'zh']);

export interface CachePolicy {
  cacheable: boolean;
  /** Short label for logs and the X-Lumen-Cache-Policy header. */
  klass: string;
  /** The Cache-Control value to set, when cacheable. */
  cacheControl: string | null;
}

const NOT: CachePolicy = { cacheable: false, klass: 'none', cacheControl: null };

function policy(klass: string, sMaxAge: number, swr: number): CachePolicy {
  return {
    cacheable: true,
    klass,
    cacheControl: `public, max-age=0, s-maxage=${sMaxAge}, stale-while-revalidate=${swr}`
  };
}

const ACCOUNT = /^(?:@|%40)([a-z0-9.-]{3,16})$/i;
const PROFILE_SUBPAGES = new Set(['followers', 'following', 'comments', 'communities']);

export function anonymousCachePolicy(input: CachePolicyInput): CachePolicy {
  if (input.method !== 'GET') return NOT;
  if (input.hasSession || input.hasQuery || input.hasQaHeader) return NOT;
  if (input.localeCookie != null && input.localeCookie !== '' && !CACHEABLE_LOCALES.has(input.localeCookie)) return NOT;
  const path = input.pathname;
  if (!path || path.includes('//')) return NOT;

  if (path === '/') return policy('home', 30, 60);

  const parts = path.split('/').slice(1);
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return NOT;

  if (parts[0] === 'topics' && parts.length === 2) return policy('topic', 60, 120);

  // /@name and its public sub-pages
  if (ACCOUNT.test(parts[0])) {
    if (parts.length === 1) return policy('profile', 300, 3600);
    if (parts.length === 2 && PROFILE_SUBPAGES.has(parts[1].toLowerCase())) return policy('profile-list', 600, 3600);
    return NOT;
  }

  // /<category>/@author/<permlink>: a post
  if (parts.length === 3 && ACCOUNT.test(parts[1]) && /^[a-z0-9-]{1,256}$/i.test(parts[2]) && /^[a-z0-9-]{1,64}$/i.test(parts[0])) {
    return policy('post', 300, 3600);
  }

  return NOT;
}
