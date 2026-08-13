import { LumenLoader } from '@hive/ui';
// Server-side t(): no 'use client' here -- see `[permlink]/loading.tsx` for
// why `i18n/server`, not `i18n/client`, is correct in this file.
// Aliased deliberately: this is the SERVER helper, an async function, NOT a
// React hook. Imported under its own name it trips `react-hooks/rules-of-hooks`
// ('cannot be called in an async function') purely because of the `use` prefix.
import { useTranslation as getServerTranslation } from '@/blog/i18n/server';

export default async function Loading() {
  const { t } = await getServerTranslation('common_blog');
  return (
    <div className="flex flex-col p-2">
      <LumenLoader size="lg" label={t('global.loading_following')} />
    </div>
  );
}
