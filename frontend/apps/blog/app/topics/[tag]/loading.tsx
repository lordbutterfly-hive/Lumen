'use client';

import { Skeleton, LumenLoader } from '@hive/ui';
import LeftRail from '@/blog/features/layouts/left-rail';
import RightRail from '@/blog/features/layouts/right-rail';
import { useTranslation } from '@/blog/i18n/client';

/**
 * ★ THE CLICK IS ANSWERED ON SCREEN AT ONCE (snappiness phase 4, 2026-09-03).
 * Without a loading boundary the router keeps the OLD page on screen until the
 * new route's code and payload have both arrived; measured on a first topic
 * click: 0.5-1.5 s during which nothing moves, which is what reads as "slow"
 * next to PeakD's ~110 ms feedback. With this file the URL and the frame
 * change immediately and the posts fill in. The rails are the real components
 * (they render from client caches) so nothing flashes but the post list.
 */
export default function Loading() {
  const { t } = useTranslation('common_blog');
  return (
    <div className="relative mx-auto grid max-w-[1720px] grid-cols-1 gap-11 px-6 pb-20 pt-[26px] md:grid-cols-[200px_minmax(0,1fr)] md:px-11 xl:grid-cols-[200px_minmax(0,1fr)_312px]">
      <div
        className="pointer-events-none absolute bottom-20 left-[244px] top-[26px] hidden w-px bg-[#ececec] md:block"
        aria-hidden
      />
      <aside className="sticky top-24 hidden h-fit bg-background-secondary md:block">
        <LeftRail />
      </aside>
      <main className="min-w-0">
        <div className="mb-6 flex flex-col gap-3">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-10 w-72" />
          <Skeleton className="h-4 w-56" />
        </div>
        <LumenLoader size="lg" label={t('global.loading_posts')} />
      </main>
      <aside className="sticky top-24 hidden h-fit bg-background-secondary xl:block">
        <RightRail />
      </aside>
    </div>
  );
}
