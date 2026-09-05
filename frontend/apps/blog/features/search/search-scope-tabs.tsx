'use client';

import BasePathLink from '@/blog/components/base-path-link';
import { cn } from '@ui/lib/utils';
import { buildSearchHref, type SearchScope, type SearchSort } from '@ui/hooks/use-search';
import { useTranslation } from '@/blog/i18n/client';

/**
 * Posts | People, as LINKS. The scope is a URL parameter (`t=`), exactly like
 * the sort, so a shared or bookmarked search opens on the same tab, the back
 * button works, and there is no second copy of the query held in component
 * state. Styled as the feed's own pill (`feed-tabs.tsx`), because a reader
 * arrives here from the feed.
 */
export default function SearchScopeTabs({
  query,
  scope,
  sort
}: {
  query: string;
  scope: SearchScope;
  sort: SearchSort;
}) {
  const { t } = useTranslation('common_blog');
  const tabs: Array<{ scope: SearchScope; label: string; testId: string }> = [
    { scope: 'posts', label: t('search_page.scope_posts', { defaultValue: 'Posts' }), testId: 'search-scope-posts' },
    { scope: 'people', label: t('search_page.scope_people', { defaultValue: 'People' }), testId: 'search-scope-people' }
  ];
  return (
    <nav aria-label={t('search_page.scope_label', { defaultValue: 'Search in' })} className="flex items-center gap-2">
      {tabs.map((tab) => {
        const current = tab.scope === scope;
        return (
          <BasePathLink
            key={tab.scope}
            href={buildSearchHref(query, sort, tab.scope)}
            aria-current={current ? 'page' : undefined}
            data-testid={tab.testId}
            className={cn(
              'inline-flex h-9 items-center rounded-full px-4 font-sans text-[14px] font-semibold leading-[22px] transition-colors',
              current
                ? 'bg-surface-brand-12 text-white shadow-[0_1px_3px_rgba(20,18,10,0.12)]'
                : 'border border-[#e4e6e9] text-[#3f4650] hover:border-line-brand-10 hover:text-ink-brand-6'
            )}
          >
            {tab.label}
          </BasePathLink>
        );
      })}
    </nav>
  );
}
