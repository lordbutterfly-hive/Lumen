import { LumenLoader } from '@hive/ui';
// Server-side t(): no 'use client' here -- see
// `[param]/[p2]/[permlink]/loading.tsx` for why `i18n/server`, not
// `i18n/client`, is correct in this file.
// Aliased deliberately: this is the SERVER helper, an async function, NOT a
// React hook. Imported under its own name it trips `react-hooks/rules-of-hooks`
// ('cannot be called in an async function') purely because of the `use` prefix.
import { useTranslation as getServerTranslation } from '@/blog/i18n/server';

/**
 * ★ NO SKELETON FOR A SEARCH BOX THAT IS NOT ON THIS PAGE (2026-08-10). This
 * used to open with a full-width rounded bar, which was the placeholder for
 * /search's own search field — the second, duplicate field that was removed.
 * Leaving it here would flash a box that never arrives. The header's field is
 * outside this boundary and is already on screen.
 *
 * The result list below it went the same way for the same reason (2026-08-12): a
 * ghost of five post cards in a layout the redesign no longer uses.
 */
export default async function Loading() {
  const { t } = await getServerTranslation('common_blog');
  return (
    <div className="relative mx-auto grid max-w-[1720px] grid-cols-1 gap-11 px-6 pb-20 pt-[26px] md:grid-cols-[200px_minmax(0,1fr)] md:px-11 xl:grid-cols-[200px_minmax(0,1fr)_312px]">
      <div className="hidden md:block" />
      <main className="flex min-w-0 flex-col gap-6">
        <LumenLoader size="lg" label={t('global.loading_search_results')} />
      </main>
    </div>
  );
}
