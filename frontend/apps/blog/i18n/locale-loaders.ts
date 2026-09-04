/**
 * ★ EXPLICIT per-locale dynamic imports so webpack splits ONE chunk per language
 * (2026-09-04, perf). The i18n backend used a FULLY dynamic template import,
 * `import(`../locales/${language}/${namespace}.json`)`, which webpack cannot
 * statically resolve, so it bundled ALL nine locales into a single ~405 KB
 * (~100 KB gzip) chunk that EVERY visitor downloaded regardless of language - a
 * Spanish reader shipped Arabic, Japanese, Chinese, Russian, Polish, etc.
 *
 * Static `import()` literals (one per locale below) make webpack emit a separate
 * chunk per language, so a reader loads only their own (~10-15 KB gzip). There is
 * one namespace today (common_blog); if more are added, extend this to key on
 * (language, namespace) rather than language alone.
 *
 * Used by BOTH i18n/client.ts and i18n/server.ts so the two stay in lockstep.
 */
type ResourceModule = { default: Record<string, unknown> };

const loaders: Record<string, () => Promise<ResourceModule>> = {
  ar: () => import('../locales/ar/common_blog.json'),
  en: () => import('../locales/en/common_blog.json'),
  es: () => import('../locales/es/common_blog.json'),
  fr: () => import('../locales/fr/common_blog.json'),
  it: () => import('../locales/it/common_blog.json'),
  ja: () => import('../locales/ja/common_blog.json'),
  pl: () => import('../locales/pl/common_blog.json'),
  ru: () => import('../locales/ru/common_blog.json'),
  zh: () => import('../locales/zh/common_blog.json')
};

/** Load the common_blog resources for one language; falls back to English. */
export function loadLocaleResources(language: string): Promise<ResourceModule> {
  return (loaders[language] ?? loaders.en)();
}
