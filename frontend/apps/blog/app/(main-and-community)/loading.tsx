'use client';

import { usePathname } from 'next/navigation';
import { LumenLoader, Skeleton } from '@hive/ui';
import { useTranslation } from '@/blog/i18n/client';

/**
 * ★ THE SIDEBARS KEEP THEIR PLACEHOLDERS, THE POST LIST DOES NOT (2026-08-12).
 *
 * The rule applied across the app: a placeholder that genuinely reserves the shape
 * the content will take stays; one that draws a ghost of something in a layout we no
 * longer use goes. This nav is a short column of same-height links, and five bars is
 * an honest picture of that — so it survives, now carrying the warm light sweep from
 * the same "first light" language as the loader rather than the old grey pulse.
 * `PostListSkeleton` was the other kind: a 150x105 thumbnail on the left of a `Card`,
 * against a real Lumen feed card that is `rounded-[18px] bg-white p-[22px]` with a
 * 190x132 image on the right. See `packages/tailwindcss/globals.css`.
 */
function SidebarSkeleton() {
  return (
    <div className="flex w-full flex-col gap-2">
      <Skeleton className="h-6 w-32" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-full" />
    </div>
  );
}

export default function Loading() {
  const { t } = useTranslation('common_blog');
  const pathname = usePathname();
  const segments = pathname?.split('/');
  // Routes like /trending/hive-xxx have a tag in the 3rd segment.
  // Main feeds (/trending, /hot) and /trending/my don't.
  const tag = segments?.[2];
  const isCommunityOrTag = tag && tag !== 'my';

  if (isCommunityOrTag) {
    // Community/tag route: the grid comes from CommunityLayout (async),
    // which hasn't loaded yet, so the skeleton must provide its own grid.
    return (
      <div className="container mx-auto max-w-screen-2xl flex-grow px-4 pb-2">
        <div className="grid grid-cols-12 md:gap-4">
          <div className="hidden md:col-span-3 md:flex xl:col-span-2">
            <SidebarSkeleton />
          </div>
          <div className="col-span-12 md:col-span-9 xl:col-span-8">
            <div className="col-span-12 mb-5 flex flex-col md:col-span-10 lg:col-span-8">
              <div className="my-4 flex w-full items-center justify-between">
                <Skeleton className="h-6 w-48" />
                <Skeleton className="h-9 w-[180px]" />
              </div>
              <LumenLoader size="lg" label={t('global.loading_posts')} />
            </div>
          </div>
          <div className="hidden xl:col-span-2 xl:flex">
            <SidebarSkeleton />
          </div>
        </div>
      </div>
    );
  }

  // Main feed route: MainPageLayout (sync client component) already
  // provides the container/grid, so the skeleton just needs the post list.
  return (
    <div className="flex flex-grow flex-col">
      <LumenLoader size="lg" label={t('global.loading_posts')} />
    </div>
  );
}
