import LeftRail from '@/blog/features/layouts/left-rail';
import RightRail from '@/blog/features/layouts/right-rail';
import ProfileMain from './profile-main';

/**
 * Profile page shell — the same fixed 3-column grid as the homepage's
 * `HomeShell` (features/discovery-feed/home-shell.tsx): 200 / 1fr / 312,
 * gap 44, max-width 1720, sticky locked rails at top-96 (design token
 * top:90px). Deliberately duplicated rather than importing HomeShell so the
 * grid keeps its own center slot (ProfileMain) without coupling the two
 * pages' layouts together.
 */
export default function ProfileGrid() {
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
        <ProfileMain />
      </main>

      <aside className="sticky top-24 hidden h-fit xl:block">
        <RightRail />
      </aside>
    </div>
  );
}
