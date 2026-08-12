export const defaultLocale = 'en';
export const languages = ['ar', 'en', 'es', 'fr', 'it', 'ja', 'pl', 'ru', 'zh'];
export const defaultNS = 'common_blog';
export const cookieName = 'NEXT_LOCALE';

export function getOptions(lng = defaultLocale, ns = defaultNS) {
  return {
    // debug: true,
    supportedLngs: languages,
    fallbackLng: defaultLocale,
    lng,
    fallbackNS: defaultNS,
    defaultNS,
    ns,
    /**
     * ★ REACT ALREADY ESCAPES — i18next MUST NOT DO IT AGAIN (2026-08-12).
     *
     * i18next defaults `escapeValue` to true because it was built for templating
     * engines that inject raw HTML. React escapes every string it renders as a JSX
     * child, so leaving this on escapes twice: an interpolated value containing an
     * apostrophe becomes `&#39;`, React then escapes the ampersand, and the reader
     * sees the literal text `&#39;` on screen. Observed live in the search results
     * heading — a search for O'Brien rendered as `O&#39;Brien`.
     *
     * This is the whole mechanism for that class of garbage, and it applied to all
     * ~130 interpolated `t()` calls in the app, not just search — search was simply
     * where someone happened to type an apostrophe.
     *
     * ★ CHECKED BEFORE CHANGING IT, because turning escaping off is exactly the kind
     * of edit that quietly opens an XSS hole: all three `dangerouslySetInnerHTML`
     * sinks in the app were read first, and none of them receives translated text.
     * They take an inline script literal (`app/layout.tsx`), the sanitised post body
     * (`rendererContainer.tsx`), and static page HTML (`static-pages`). Every `t()`
     * result lands as a JSX child, where React's own escaping is the real defence.
     */
    interpolation: { escapeValue: false }
  };
}
