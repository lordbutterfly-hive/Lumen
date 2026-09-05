/**
 * ★★★ THE DEFAULT LOCALE IS COOKIE-FREE (2026-09-05, snappiness).
 *
 * Every visitor used to be handed `NEXT_LOCALE=en` by the header's mount
 * effect, whether or not they had ever touched the language switcher. That one
 * cookie is what kept the site off the edge cache:
 *
 *   · Cloudflare (Free plan) CANNOT vary a cache key on a cookie, so the
 *     owner's "Anon HTML edge cache" rule carries `not http.cookie contains
 *     "NEXT_LOCALE"` (see LUMEN-DOCS/BENCHMARK-AND-PHASEB-2026-09-04.md). A
 *     request carrying the cookie is DYNAMIC by rule, every time.
 *   · So only a visitor's very FIRST request could ever be a cf HIT: the reply
 *     to it planted the cookie, and every reload and return visit after that
 *     went to the origin in France. Measured 2026-09-05 with curl against
 *     prod: HIT with the anonymous session cookies present, DYNAMIC the moment
 *     `NEXT_LOCALE` is added. The 09-05 cross-site benchmark has Lumen slowest
 *     warm on every page for exactly this reason (home warm: Ecency 73 ms vs
 *     Lumen 381 ms).
 *
 * ABSENCE ALREADY MEANS `en` EVERYWHERE, which is why the cookie buys nothing
 * for a default-language reader. Checked, all five readers:
 *   app/layout.tsx:321        `cookieStore.get('NEXT_LOCALE')?.value || 'en'`
 *   i18n/server.ts:20         `cookies().get(cookieName)?.value ?? defaultLocale`
 *   i18n/client.ts            `getInitialLanguage()` falls back to `<html lang>`
 *                             (server-rendered `en`) then `defaultLocale`; the
 *                             server branch of `useTranslation` is explicitly
 *                             `lng || defaultLocale`
 *   packages/ui/components/time-ago.tsx:102  `lang || getCookie(...) || 'en'`
 *   middleware.ts:67 -> lib/anonymous-cache-policy.ts:85  a null locale cookie
 *                             is cacheable, exactly like the string `en`
 * And at the origin proxy, absence and `en` produce the SAME Souin key:
 * /opt/lumen/caddy/Caddyfile keys on the `X-Lumen-Locale` header (lines 23-26)
 * which is set to the literal `en` for a request with no locale cookie
 * (`@nolocale`, line 60) and to the cookie value for one that has a valid one
 * (`@haslocale`, line 59). So dropping the cookie does not split the origin
 * cache: cookie-less and `en` readers keep sharing one stored page.
 *
 * These helpers are pure so the decision can be unit-tested without a DOM; see
 * locale-cookie.test.ts. `document.cookie` assignment lives at the call sites
 * (features/layouts/site-header/client-effects.tsx and utils/language.ts).
 */
import { cookieName, defaultLocale } from '../i18n/settings';

/**
 * `SameSite=Lax; path=/` is load-bearing and has its own scar: a cookie with
 * NO `path` gets RFC 6265's default-path (the DIRECTORY of the current URL),
 * so the old code planted `NEXT_LOCALE=en` at `/@alice` for anyone who arrived
 * on a profile link, and the browser then sent that narrow copy AHEAD of the
 * site-wide one the switcher wrote. Stated here once so no call site can
 * forget it. See the duplicate cleanup in client-effects.tsx.
 */
const COOKIE_ATTRS = 'SameSite=Lax; path=';

/** `document.cookie` string that STORES a locale at the site root. */
export function localeCookieWrite(locale: string): string {
  return `${cookieName}=${locale}; ${COOKIE_ATTRS}/`;
}

/**
 * `document.cookie` string that EXPIRES the locale cookie at one path. The
 * path must match the one the cookie was written at, which is why the
 * duplicate cleanup walks the URL's prefixes.
 */
export function localeCookieDelete(path = '/'): string {
  return `${cookieName}=; Max-Age=0; ${COOKIE_ATTRS}${path}`;
}

/**
 * What the language switcher should assign to `document.cookie` for an
 * explicit choice. Picking the DEFAULT language deletes the cookie instead of
 * writing `en`, so a reader who deliberately chooses English is edge-cacheable
 * like one who never chose at all. The choice itself is not lost: `setLanguage`
 * still records it in localStorage, which is what `getLanguage()` reads first
 * and which the Condenser migration checks before it migrates anything.
 */
export function localeCookieForChoice(locale: string): string {
  return locale === defaultLocale ? localeCookieDelete('/') : localeCookieWrite(locale);
}

export type LocaleCookieAction = 'none' | 'clear-duplicates' | 'delete';

export interface LocaleCookieMountInput {
  /**
   * What `getCookie(LOCALE_KEY)` returns: the value, or `''` when the cookie is
   * absent AND, note, also when there is more than one copy of it (getCookie
   * splits on the name and bails unless it finds exactly one). That aliasing is
   * why `cookieCount` is tested FIRST below.
   */
  cookieValue: string;
  /** How many `NEXT_LOCALE=` entries `document.cookie` currently shows. */
  cookieCount: number;
}

/**
 * The mount decision, in one place.
 *
 * ★ `clear-duplicates` IS TESTED FIRST, AND THAT IS A FIX, NOT A REORDER. The
 * previous shape was `if (!getCookie(...)) write-en; else if (duplicates)
 * clean;` and `getCookie` returns `''` for a duplicated cookie, so the cleanup
 * branch was UNREACHABLE in exactly the situation it existed for: a visitor
 * carrying a narrow `en` plus a site-wide `pl` fell into the first branch and
 * had their Polish choice overwritten with `en` at `path=/`. Duplicates are now
 * resolved before any value is trusted, and the caller re-reads and re-asks.
 */
export function localeCookieMountAction(input: LocaleCookieMountInput): LocaleCookieAction {
  if (input.cookieCount > 1) return 'clear-duplicates';
  // THE FIX: no cookie means the default, at every reader listed in this
  // file's header. Writing it would only cost the reader the edge cache.
  if (input.cookieValue === '') return 'none';
  // ★ A DEFAULT-VALUED COOKIE IS EXPIRED UNCONDITIONALLY, INCLUDING ONE A
  // READER CHOSE ON PURPOSE (owner call, 2026-09-05). It carries no
  // information: absence means `en` at every reader listed above, and the
  // proxy keys absence and `en` to the same entry, so the cookie changes
  // nothing but the reader's cache eligibility. The CHOICE is not the cookie:
  // `setLanguage` records it in localStorage, `getLanguage()` reads that
  // first, and the Condenser migration keys off it, so a deliberate English
  // reader keeps their preference and gains the edge cache.
  if (input.cookieValue === defaultLocale) return 'delete';
  return 'none';
}
