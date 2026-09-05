'use client';

import { useEffect } from 'react';
import { getCookie } from '@ui/lib/utils';
import { getLanguage, LOCALE_KEY } from '@/blog/utils/language';
import { localeCookieDelete, localeCookieMountAction } from '@/blog/lib/locale-cookie';

export default function ClientEffects() {
  useEffect(() => {
    /**
     * ★★★ A COOKIE WITH NO `path` IS NOT A SITE-WIDE COOKIE (2026-08-13).
     *
     * This wrote `NEXT_LOCALE=en; SameSite=Lax` — no `path`. RFC 6265's
     * default-path is the *directory* of the current URL, so where the cookie
     * lands depends entirely on which page a visitor happened to arrive on:
     * `/` and `/@alice` both give `path=/`, but `/@alice/settings` or any
     * `/community/@author/permlink` — a shared link, a search result, the most
     * common way anyone arrives — gives `path=/@alice`.
     *
     * The language switcher writes its choice at `path=/` (utils/language.ts).
     * Both cookies then exist under the same name, and a browser sends the
     * MORE SPECIFIC path first — which is the one `cookies().get()` (root
     * layout) and `getCookie()` (this file, i18n/client.ts, time-ago) each
     * return. So the stale `en` outranks the visitor's actual choice on every
     * page under that prefix, permanently.
     *
     * MEASURED on the shipped build at :3000, signed in, before this change:
     *   1. first visit to /@lordbutterfly/settings  -> cookie `en @ /@lordbutterfly`
     *   2. choose Polish at the site root           -> cookie `pl @ /`
     *   3. back to /@lordbutterfly/settings         -> document.cookie is
     *      ["NEXT_LOCALE=en", "NEXT_LOCALE=pl"] and <html lang> is "en"
     *
     * That is exactly the "the language switcher does nothing" shape reported
     * in audit §1.2, and it is invisible to anyone testing only from `/`.
     *
     * Fix: state `path=/`, so there is one cookie and it is the site's.
     *
     * ★★★ AND THE DEFAULT LOCALE NO LONGER GETS A COOKIE AT ALL (2026-09-05).
     *
     * The line this replaced planted `NEXT_LOCALE=en` on every visitor who did
     * not have one, which is every first-time reader. That cookie is the reason
     * the site is not on the edge cache: Cloudflare Free cannot vary a cache key
     * on a cookie, so the owner's anonymous-HTML rule excludes any request
     * carrying `NEXT_LOCALE` (LUMEN-DOCS/BENCHMARK-AND-PHASEB-2026-09-04.md).
     * Only a visitor's FIRST request could ever hit the edge; the response to it
     * planted the cookie, and every reload afterwards went to the origin in
     * France. Measured with curl against prod on 2026-09-05: HIT with the
     * anonymous session cookies present, DYNAMIC as soon as `NEXT_LOCALE` is
     * added.
     *
     * Absence already means `en` in every reader (root layout, i18n server and
     * client, TimeAgo, the middleware's cache policy) and the origin proxy keys
     * absence and `en` to the SAME Souin entry, so nothing renders differently
     * and the origin cache does not split. The proof for each of those, with
     * file and line, is in lib/locale-cookie.ts. A reader who actually chose a
     * language still gets a cookie, and it is still written at `path=/`.
     *
     * A `NEXT_LOCALE=en` cookie already in a reader's jar is expired here on
     * their next page load, whether it was planted by the old auto-writer or
     * chosen deliberately (owner call, 2026-09-05): it says nothing that its
     * absence does not, and localStorage keeps the deliberate choice. So an
     * English reader becomes edge-eligible from their second load onward.
     */
    if (typeof window === 'undefined') return;

    const readCookieState = () => ({
      cookieValue: getCookie(LOCALE_KEY),
      cookieCount: document.cookie.split('; ').filter((c) => c.startsWith(`${LOCALE_KEY}=`)).length
    });

    let action = localeCookieMountAction(readCookieState());

    if (action === 'clear-duplicates') {
      // Self-heal for anyone already carrying a narrow duplicate written by the
      // old code. Expire it at every path prefix of this URL EXCEPT `/`: those
      // are the only paths a stray copy can be sitting on and still be visible
      // here, and skipping `/` is what stops this from deleting the real,
      // site-wide cookie. Expiring a path that holds nothing is a no-op.
      let prefix = '';
      for (const segment of window.location.pathname.split('/').filter(Boolean)) {
        prefix += `/${segment}`;
        document.cookie = localeCookieDelete(prefix);
      }
      // The cleanup changes what `getCookie` can see (it reports '' while a
      // duplicate exists), so the surviving single cookie only becomes
      // readable now. Ask again with the healed jar.
      action = localeCookieMountAction(readCookieState());
    }

    if (action === 'delete') {
      document.cookie = localeCookieDelete('/');
    }

    // Handle language setting from localStorage/cookies
    const savedLang = getLanguage();
    if (savedLang) {
      document.documentElement.lang = savedLang;
    }
  }, []);

  // Global handler for browser back/forward navigation in subdirectory deployments
  // This fixes issues when navigating back between different route handlers
  useEffect(() => {
    const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';
    if (basePath) {
      const handlePopState = () => {
        // Get the current path without basePath
        const pathWithoutBase = window.location.pathname.replace(basePath, '');

        // Force reload when navigating to/from user profile pages
        // This ensures the correct route handler is used
        if (pathWithoutBase.startsWith('/@')) {
          // Small timeout to let browser complete navigation first
          setTimeout(() => {
            window.location.replace(window.location.href);
          }, 0);
        }
      };

      window.addEventListener('popstate', handlePopState);
      return () => window.removeEventListener('popstate', handlePopState);
    }
  }, []);

  return null;
}
