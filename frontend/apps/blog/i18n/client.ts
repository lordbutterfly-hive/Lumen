'use client';

import { useEffect, useState } from 'react';
import i18next, { Resource } from 'i18next';
import { initReactI18next, useTranslation as useTranslationOrg } from 'react-i18next';
import resourcesToBackend from 'i18next-resources-to-backend';
import { loadLocaleResources } from './locale-loaders';
import { getOptions, languages, cookieName, defaultLocale, defaultNS } from './settings';

import { isServer } from '@tanstack/react-query';

/**
 * ★★★ THE SSR RACE (2026-08-10/11).
 *
 * Below, `i18next.init(...)` is a module-level side effect and its resource
 * load is genuinely async: `resourcesToBackend` reads each namespace through
 * `import(...)`, a Promise nobody here awaits. That is fine in the BROWSER —
 * react-i18next's `useTranslation` throws a Suspense promise when a namespace
 * isn't ready yet (the default `useSuspense: true`, never overridden in this
 * app), so a slow load shows a loading boundary, not a raw key, and the
 * lazy `import()` per language keeps 8 languages' worth of JSON out of
 * everyone's bundle.
 *
 * On the SERVER there is no such protection against the CLASS of bug, only
 * against today's timing: nothing suspends node's `renderToPipeableStream`
 * for you across a route boundary the way Next's `loading.tsx` does for a
 * client remount, so a server render that reached `t()` before the backend's
 * `import()` had a turn to resolve would emit `profile.following` into the
 * response body — no fallback, no boundary, just the key. The fix here is not
 * to await the module-level `init()` (an async gap at module scope, followed
 * by a synchronous render call, is exactly the shape of the bug); it is to
 * remove the gap entirely for the server path. `require(...)` of a JSON file
 * is synchronous, so building `resources` this way means every namespace is
 * already in the i18next store before `.init()` is even called — no
 * import(), no promise, no window for a request to render ahead of its data.
 *
 * The BROWSER keeps the async backend untouched: `loadServerResources()`
 * returns `undefined` there (this same module runs in both places, per
 * `'use client'`), so the client bundle still only downloads the visitor's
 * own language and language-switching still works exactly as before.
 */
function loadServerResources(): Resource | undefined {
  if (typeof window !== 'undefined') return undefined;
  const resources: Resource = {};
  for (const language of languages) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- sync load is the point; see comment above.
    resources[language] = { [defaultNS]: require(`../locales/${language}/${defaultNS}.json`) };
  }
  return resources;
}

/**
 * Gets the language from cookie, works on both server and client side
 * On server: tries to use Next.js cookies() if available
 * On client: uses document.cookie
 * Returns the language code or empty string if not found
 */
export const getLanguageFromCookie = (): string => {
  // Server-side: try to use Next.js cookies() if available
  if (typeof window === 'undefined') {
    try {
      // Dynamic import to avoid issues in client components
      const { cookies } = require('next/headers');
      const cookieStore = cookies();
      const cookie = cookieStore.get(cookieName);
      return cookie?.value || '';
    } catch (error) {
      // If cookies() is not available (e.g., in client component), return empty string
      return '';
    }
  }

  // Client-side: use document.cookie
  const name = cookieName + '=';
  const decodedCookie = decodeURIComponent(document.cookie);
  const ca = decodedCookie.split(';');
  for (let i = 0; i < ca.length; i++) {
    let c = ca[i];
    while (c.charAt(0) === ' ') {
      c = c.substring(1);
    }
    if (c.indexOf(name) === 0) {
      return c.substring(name.length, c.length);
    }
  }
  return '';
}


function getInitialLanguage(): string {
  if (typeof document === 'undefined') {
    return defaultLocale;
  }
  const htmlLang = document.documentElement.lang;
  if (htmlLang && languages.includes(htmlLang)) {
    return htmlLang;
  }
  const cookieLang = getLanguageFromCookie();
  if (cookieLang && languages.includes(cookieLang)) {
    return cookieLang;
  }
  return defaultLocale;
}

i18next
  .use(initReactI18next)
  .use(
    resourcesToBackend((language: string) => loadLocaleResources(language))
  )
  .init({
    ...getOptions(getInitialLanguage()),
    // Server: every language is already in the store below, so this render
    // (and every one after it) has real strings from the first byte, not a
    // Promise racing the response. Client: `undefined` is a no-op — the
    // `resourcesToBackend` backend above still lazy-loads one language at a
    // time exactly as it did before this fix.
    resources: loadServerResources(),
    detection: {
      order: ['cookie', 'path', 'htmlTag', 'navigator'],
      cookieName
    },
    preload: languages
  });

export function useTranslation(ns: string, options?: any) {
  const lng = getLanguageFromCookie();
  const ret = useTranslationOrg(ns, options);

  const { i18n } = ret;

  if (isServer) {
    // ★★★ THE CROSS-REQUEST LANGUAGE LEAK (2026-08-11).
    //
    // `i18next` above is a module-level singleton: one instance per Node
    // process, shared by every concurrent request AND by every request that
    // comes after. The code this replaced called `i18n.changeLanguage(lng)`
    // here, which MUTATES that shared instance's `language`/`resolvedLanguage`
    // — fine for the component that just called it, but every other
    // in-flight render (a different visitor's request, interleaved on
    // Node's single event loop) and every later render both read that same
    // mutated property until someone else mutates it again.
    //
    // Worse, the mutation was gated on `lng &&`: a COOKIE-LESS visitor (a
    // real first-time visitor with no `NEXT_LOCALE` cookie yet, or any
    // crawler) has `lng === ''`, so that branch was skipped entirely — such
    // a request never corrected the singleton to the default language, it
    // just read whatever a PRIOR visitor's request had last left it in.
    // Proven live: prime the shared instance with one `NEXT_LOCALE=ar`
    // request, then send a plain cookie-less request — the second response
    // renders Arabic strings server-side under an `<html lang="en">` shell
    // (the root layout reads the cookie directly, independent of this
    // singleton, so it stays correctly 'en' while the translated content
    // does not — a guaranteed hydration mismatch, and exactly the shape
    // originally reported).
    //
    // The fix removes the mutation instead of trying to time it better.
    // `i18n.getFixedT(lng, ns)` returns a `t` that reads its language from
    // the ARGUMENT every call, never from `i18n.language` — so binding it to
    // this request's own `lng` (or the default when there is no cookie) makes
    // every request self-contained: nothing is read from shared mutable
    // state, and nothing is written to it either, so there is nothing left
    // for one request to leak into another. This is the same primitive
    // `i18n/server.ts` already uses for real Server Components; this is the
    // client-component-safe way to reach it (no `await`, so it can run
    // inside the synchronous hooks a `'use client'` component is allowed).
    //
    // `i18n` is still returned for the handful of callers that read
    // `i18n.resolvedLanguage` directly for locale-aware number/date
    // formatting (e.g. features/wallet/components/account-history-row.tsx).
    // `Object.create(i18n)` makes a request-scoped VIEW: `resolvedLanguage`/
    // `language` are shadowed with THIS request's language as the view's own
    // properties, while every other read (and any method call, via the
    // prototype chain) still reaches the live shared instance. Nothing about
    // this view is ever mutated back onto the singleton.
    const resolvedLng = lng || defaultLocale;
    const scopedI18n = Object.create(i18n);
    scopedI18n.language = resolvedLng;
    scopedI18n.resolvedLanguage = resolvedLng;
    return {
      ...ret,
      t: i18n.getFixedT(resolvedLng, ns, options?.keyPrefix),
      i18n: scopedI18n
    };
  }

  // Client branch, unchanged: `isServer` is a module-scope constant (stable
  // for the lifetime of this bundle), so hooks are still called the same
  // number of times on every render — this just no longer shares an `if`
  // with data-dependent conditions the way the old branch did.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const [activeLng, setActiveLng] = useState(i18n.resolvedLanguage);
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useEffect(() => {
    if (activeLng === i18n.resolvedLanguage) return;
    setActiveLng(i18n.resolvedLanguage);
  }, [activeLng, i18n.resolvedLanguage]);
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useEffect(() => {
    if (!lng || i18n.resolvedLanguage === lng) return;
    i18n.changeLanguage(lng);
  }, [lng, i18n]);
  return ret;
}
