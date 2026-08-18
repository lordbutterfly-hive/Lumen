import LeftRail from '@/blog/features/layouts/left-rail';
import RightRail from '@/blog/features/layouts/right-rail';
import ShortFormComposer from '@/blog/features/discovery-feed/short-form-composer';
import FeedTabs from '@/blog/features/discovery-feed/feed-tabs';
import { WeeklyRecapCard } from '@/blog/features/retention/components/weekly-recap-card';
import { RetentionNudge } from '@/blog/features/retention/components/retention-nudge';
import { StreakCardNarrow } from '@/blog/features/retention/components/streak-card';
import HomeIntro from '@/blog/components/home-intro';
// ★ SERVER-SIDE t(), NOT `i18n/client` (a11y item 8/O5). This file has no
// `'use client'` and is rendered directly by `app/page.tsx` (itself a Server
// Component -- it calls `cookies()`), so it is a genuine Server Component.
// `i18n/client`'s `useTranslation` is a real hook (`useState`/`useEffect` in
// its client branch) and would crash here; `i18n/server`'s is a plain async
// function built for exactly this case.
// Aliased deliberately: this is the SERVER helper, an async function, NOT a
// React hook. Imported under its own name it trips `react-hooks/rules-of-hooks`
// ('cannot be called in an async function') purely because of the `use` prefix.
import { useTranslation as getServerTranslation } from '@/blog/i18n/server';

/**
 * Home shell — the redesign's fixed 3-column grid (200 / 1fr / 312, gap 44,
 * max-width 1720, symmetric 44px gutters, centered). A 1px vertical divider sits
 * at the left nav's right edge (x=244 = 200 nav + 44 gutter). Left = nav (holds
 * the retention league showcase atop it), center = composer + tabs, right = rail.
 * Responsive: nav collapses below md, right rail below xl.
 */
export default async function HomeShell({ showIntro = false }: { showIntro?: boolean }) {
  const { t } = await getServerTranslation('common_blog');
  return (
    <div className="relative mx-auto grid max-w-[1720px] grid-cols-1 gap-11 px-6 pb-20 pt-[26px] md:grid-cols-[200px_minmax(0,1fr)] md:px-11 xl:grid-cols-[200px_minmax(0,1fr)_312px]">
      {/* 1px vertical divider at the nav's right edge — equal 44px gutter each side */}
      <div
        className="pointer-events-none absolute bottom-20 left-[244px] top-[26px] hidden w-px bg-[#ececec] md:block"
        aria-hidden
      />

      <aside className="sticky top-24 hidden h-fit bg-background-secondary md:block">
        <LeftRail />
      </aside>

      <main className="min-w-0">
        {/* ★ A11Y ITEM 8/O5 -- one <h1> per page. The redesign deliberately has
            no visible page title on the feed, so a visually-hidden heading is
            the honest minimum: it names the landmark for a screen reader
            without adding a title nothing else on the page has. */}
        <h1 className="sr-only">{t('global.home_feed')}</h1>
        {/* ★ ORDER MATTERS AND IT IS ONE-IN, ONE-OUT. The nudge is at most ONE line
            once a day and renders nothing most days; the recap is one card on Mondays.
            Both sit above the composer because they are read and dismissed, not
            returned to. Anything added here later has to earn the same silence: three
            stacked retention cards above the composer is the wall of text this whole
            rework exists to undo. */}
        {/* ★★ THE STREAK MUST EXIST ON A PHONE (2026-08-09, found by a council seat).
            Its predecessor was mounted ONLY in the right rail, which is `hidden xl:block`,
            so it did not render below 1280px. Not just phones: most laptops. A daily habit
            mechanic put in furniture that disappears on the device people actually read on
            is the most expensive kind of quiet bug — it costs the whole feature for the
            majority of sessions and nothing looks broken.
            `xl:hidden` here, and the rail keeps its own copy from xl up, so exactly one
            renders at every width.
            `surface="inline"` scopes this copy's testids — both mounts are in the DOM at
            once, only one is visible, and sharing ids made every selector match two
            elements. See StreakSurface in streak-card.tsx. */}
        {/* Signed-out orientation hero. FIRST in the column so it reads as the
            page's masthead, exactly as the topic header does on /topics/*, and it
            is absent entirely for a signed-in reader (decided server-side in
            app/page.tsx, so it is either in the first paint or not in the DOM). */}
        {showIntro ? <HomeIntro /> : null}
        <StreakCardNarrow />
        <RetentionNudge className="mb-4" />
        <WeeklyRecapCard className="mb-6" />
        <ShortFormComposer />
        <div className="mt-6">
          <FeedTabs />
        </div>
      </main>

      <aside className="sticky top-24 hidden h-fit bg-background-secondary xl:block">
        <RightRail />
      </aside>
    </div>
  );
}
