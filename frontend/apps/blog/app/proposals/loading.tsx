import { LumenLoader, Skeleton } from '@hive/ui';
import DhfStatsBar from '@/blog/features/proposals/components/dhf-stats-bar';
// Server-side t(): no 'use client' here (a `loading.tsx` is a Server
// Component boundary) -- see `[param]/[p2]/[permlink]/loading.tsx` for why
// `i18n/server`, not `i18n/client`, is correct in this file.
// Aliased deliberately: this is the SERVER helper, an async function, NOT a
// React hook. Imported under its own name it trips `react-hooks/rules-of-hooks`
// ('cannot be called in an async function') purely because of the `use` prefix.
import { useTranslation as getServerTranslation } from '@/blog/i18n/server';

/**
 * ★ 2026-08-17 — `/proposals` had NO loading.tsx at all, so a slow navigation
 * here showed nothing (the old page just sat there, then jumped straight to
 * the finished proposals list). `app/proposals/page.tsx` has no layout.tsx of
 * its own, so `ProposalsContent` (`features/proposals/components/
 * proposals-content.tsx`) draws the ENTIRE screen — rail, header, list, right
 * rail — and all of it is what this fallback has to stand in for, not just
 * the list. Same convention as `communities/loading.tsx`: reproduce the exact
 * grid/rail classes so nothing shifts when the real tree mounts.
 */
function SidebarSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      <Skeleton className="h-6 w-32" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-full" />
    </div>
  );
}

/** Stand-in for `PageMasthead` as `ProposalsMainHeader` calls it: no eyebrow,
 *  a title + italic subtitle, an intro line, and the "New proposal" button
 *  pinned to the meta row. Same header shell classes as `page-masthead.tsx`
 *  so the card's size/border/gradient don't change when the real one lands. */
function MastheadSkeleton() {
  return (
    <header className="relative mb-7 overflow-hidden rounded-panel border border-line-warn-3 accent-rail bg-[radial-gradient(125%_130%_at_0%_0%,rgb(var(--masthead-1))_0%,rgb(var(--masthead-2))_30%,rgb(var(--masthead-3))_58%,rgb(var(--masthead-4))_85%)] px-7 pb-5 pt-7">
      <Skeleton className="h-[38px] w-[300px]" />
      <div className="mt-3.5 flex flex-wrap items-center gap-3">
        <Skeleton className="h-4 w-[420px] max-w-full" />
        <Skeleton className="ml-auto h-11 w-[152px] shrink-0 rounded-control" />
      </div>
    </header>
  );
}

/** Stand-in for `ProposalsToolbar`: the four-tab segmented control plus the
 *  sort dropdown, same container classes so the row holds its height. */
function ToolbarSkeleton() {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
      <div className="flex gap-1.5 rounded-xl border border-line-6 bg-surface-21 p-[5px]">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-[84px] rounded-lg" />
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Skeleton className="h-4 w-14" />
        <Skeleton className="h-9 w-32 rounded-control" />
      </div>
    </div>
  );
}

/** Stand-in for `ProposalsRightRail`'s two cards (`ReturnThresholdCard`,
 *  `ProxyCard`) -- both share this exact `rounded-panel border ... p-5` shell. */
function RightRailCardSkeleton() {
  return (
    <div className="rounded-panel border border-line-9 bg-surface-1 p-5">
      <Skeleton className="mb-1.5 h-[19px] w-32" />
      <Skeleton className="mb-1 h-[13px] w-full" />
      <Skeleton className="mb-3.5 h-[13px] w-4/5" />
      <Skeleton className="h-11 w-full rounded-control" />
    </div>
  );
}

export default async function Loading() {
  const { t } = await getServerTranslation('common_blog');
  return (
    <div className="relative mx-auto grid max-w-[1720px] grid-cols-1 gap-11 px-6 pb-20 pt-[26px] md:grid-cols-[200px_minmax(0,1fr)] md:px-11 xl:grid-cols-[200px_minmax(0,1fr)_312px]">
      <div
        className="pointer-events-none absolute bottom-20 left-[244px] top-[26px] hidden w-px bg-surface-26 md:block"
        aria-hidden
      />

      <aside className="sticky top-24 hidden h-fit bg-background-secondary md:block">
        <SidebarSkeleton />
      </aside>

      <main className="min-w-0">
        <MastheadSkeleton />
        {/* Real `DhfStatsBar` already owns an honest `stats === undefined` skeleton
            state -- reused as-is instead of re-drawing it, so this can never drift
            from the real loading look of that bar. */}
        <DhfStatsBar stats={undefined} />
        <ToolbarSkeleton />
        <Skeleton className="mb-1.5 h-4 w-40" />
        <LumenLoader size="lg" label={t('global.loading_proposals')} />
      </main>

      <aside className="sticky top-24 hidden h-fit flex-col gap-5 bg-background-secondary xl:flex">
        <RightRailCardSkeleton />
        <RightRailCardSkeleton />
      </aside>
    </div>
  );
}
