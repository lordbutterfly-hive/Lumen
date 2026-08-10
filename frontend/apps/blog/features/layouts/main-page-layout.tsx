'use client';

import { ReactNode } from 'react';
import LeftRail from './left-rail';
import RightRail from './right-rail';
import { CommunitiesSelect } from '@/blog/features/layouts/communities-select';
import PostSelectFilter from '@/blog/features/layouts/post-select-filter';
import { useTranslation } from '@/blog/i18n/client';

/**
 * ★ THE LUMEN SHELL, NOT THE INHERITED DENSE GRID (owner report, 2026-08-08).
 *
 * This was a bootstrap-style `grid-cols-12` with a "Trending Communities"
 * sidebar on the LEFT (`renderCommunitiesSidebar`) and, for a logged-in
 * reader, the SAME sidebar rendered a second time on the right (the xl slot
 * fell back to `CommunitiesSidebar` whenever `user.isLoggedIn`) — visible as
 * two identical "All posts / Trending Communities" panels on `/trending`,
 * `/hot` and `/created`. There was also no `LeftRail` at all, so every page
 * that goes through this layout still read as the old product.
 *
 * Same fixed 3-column grid as `HomeShell` / `TopicShell` / `ProfileGrid`:
 * `LeftRail`, content, `RightRail` (whose Topics card is the Lumen
 * replacement for the old "Trending Communities" list). The header row (list
 * name + sort dropdown) and the subscriptions-driven mobile community picker
 * are UNCHANGED in behaviour — only the chrome around them moved. This layout
 * is shared by `/trending`, `/hot`, `/created`, `/muted`, `/payout`, their
 * `/my` variants, `/@username/feed` and `/communities`
 * (`hidePostsHeader={true}`), so all of them pick this up at once.
 */
const MainPageLayout = ({
  children,
  tag = '',
  hidePostsHeader = false
}: {
  children: ReactNode;
  tag?: string;
  hidePostsHeader?: boolean;
}) => {
  const { t } = useTranslation('common_blog');

  const renderListName = () => {
    if (tag === 'feed') return t('navigation.communities_nav.my_friends');
    return t('navigation.communities_nav.all_posts');
  };

  return (
    <div className="relative mx-auto grid max-w-[1720px] grid-cols-1 gap-11 px-6 pb-20 pt-[26px] md:grid-cols-[200px_minmax(0,1fr)] md:px-11 xl:grid-cols-[200px_minmax(0,1fr)_312px]">
      <div
        className="pointer-events-none absolute bottom-20 left-[244px] top-[26px] hidden w-px bg-[#ececec] md:block"
        aria-hidden
      />

      <aside className="sticky top-24 hidden h-fit md:block">
        <LeftRail />
      </aside>

      <main className="min-w-0">
        {hidePostsHeader ? null : (
          <div className="mb-5 flex w-full items-center justify-between" translate="no">
            <div className="mr-2 flex w-[320px] flex-col">
              <span
                className="hidden font-sans text-[15px] font-semibold text-[#161511] md:block"
                data-testid="community-name"
              >
                {renderListName()}
              </span>
              <span className="md:hidden">
                <CommunitiesSelect title={t('navigation.communities_nav.all_posts')} />
              </span>
            </div>
            {tag !== 'feed' && (
              <div className="w-[180px]">
                <PostSelectFilter param={tag} />
              </div>
            )}
          </div>
        )}
        {children}
      </main>

      <aside className="sticky top-24 hidden h-fit xl:block">
        <RightRail />
      </aside>
    </div>
  );
};
export default MainPageLayout;
