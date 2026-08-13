import { LumenLoader } from '@hive/ui';
// Server-side t(): no 'use client' here (a `loading.tsx` is a Server
// Component boundary) -- see the sibling `[permlink]/loading.tsx` for why
// `i18n/server`, not `i18n/client`, is the correct import in this file.
// Aliased deliberately: this is the SERVER helper, an async function, NOT a
// React hook. Imported under its own name it trips `react-hooks/rules-of-hooks`
// ('cannot be called in an async function') purely because of the `use` prefix.
import { useTranslation as getServerTranslation } from '@/blog/i18n/server';

export default async function Loading() {
  const { t } = await getServerTranslation('common_blog');
  return (
    <div className="flex flex-grow flex-col pt-4">
      <LumenLoader size="lg" label={t('global.loading_profile')} />
    </div>
  );
}
