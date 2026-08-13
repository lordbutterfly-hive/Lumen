import FollowListSkeleton from '@/blog/features/account-lists/follow-list/follow-list-skeleton';
// Server-side t(): no 'use client' here -- see `[permlink]/loading.tsx` for
// why `i18n/server`, not `i18n/client`, is correct in this file.
// Aliased deliberately: this is the SERVER helper, an async function, NOT a
// React hook. Imported under its own name it trips `react-hooks/rules-of-hooks`
// ('cannot be called in an async function') purely because of the `use` prefix.
import { useTranslation as getServerTranslation } from '@/blog/i18n/server';

/**
 * ★ THE ROUTE-LEVEL FALLBACK IS THE SAME SKELETON THE CLIENT USES.
 *
 * This used to be a centred `<LumenLoader size="lg">` inside a `div.p-2`, while
 * the client component rendered a different, smaller `<Loading>` spinner once it
 * mounted — so the page changed shape twice before the first row appeared, and
 * neither shape was the shape of the list. Eight 60px skeleton rows inside the
 * real card mean the layout is already in its final position. The loader's
 * accessible label is kept, as screen-reader-only text on the skeleton.
 */
export default async function Loading() {
  const { t } = await getServerTranslation('common_blog');
  return <FollowListSkeleton label={t('global.loading_followers')} />;
}
