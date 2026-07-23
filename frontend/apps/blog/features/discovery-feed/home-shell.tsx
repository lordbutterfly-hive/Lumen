import LeftRail from '@/blog/features/layouts/left-rail';
import RightRail from '@/blog/features/layouts/right-rail';
import ShortFormComposer from '@/blog/features/discovery-feed/short-form-composer';
import FeedTabs from '@/blog/features/discovery-feed/feed-tabs';

/**
 * Home shell — the redesign's fixed 3-column grid (200 / 1fr / 312, gap 44,
 * max-width 1720, symmetric 44px gutters, centered). A 1px vertical divider sits
 * at the left nav's right edge (x=244 = 200 nav + 44 gutter). Left = nav (holds
 * the retention league showcase atop it), center = composer + tabs, right = rail.
 * Responsive: nav collapses below md, right rail below xl.
 */
export default function HomeShell() {
  return (
    <div className="relative mx-auto grid max-w-[1720px] grid-cols-1 gap-11 px-6 pb-20 pt-[26px] md:grid-cols-[200px_minmax(0,1fr)] md:px-11 xl:grid-cols-[200px_minmax(0,1fr)_312px]">
      {/* 1px vertical divider at the nav's right edge — equal 44px gutter each side */}
      <div
        className="pointer-events-none absolute bottom-20 left-[244px] top-[26px] hidden w-px bg-[#ececec] md:block"
        aria-hidden
      />

      <aside className="sticky top-24 hidden h-fit md:block">
        <LeftRail />
      </aside>

      <main className="min-w-0">
        <ShortFormComposer />
        <div className="mt-6">
          <FeedTabs />
        </div>
      </main>

      <aside className="sticky top-24 hidden h-fit xl:block">
        <RightRail />
      </aside>
    </div>
  );
}
