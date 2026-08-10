import type { Metadata } from 'next';
import LeftRail from '@/blog/features/layouts/left-rail';
import RanksLadder from '@/blog/features/retention/components/ranks-ladder';

export const metadata: Metadata = {
  title: 'Ranks',
  description: 'Every rung on the Lumen ladder, what it means, and what moves you up one.'
};

/**
 * /ranks — linked from the rank popover in the left rail and from the profile
 * league card. Same 2-column shell as the wallet page (nav + content, no right
 * rail: the ladder is the content and does not want a sidebar competing with it).
 */
export default function RanksPage() {
  return (
    <div className="relative mx-auto grid max-w-[1720px] grid-cols-1 gap-11 px-6 pb-20 pt-[26px] md:grid-cols-[200px_minmax(0,1fr)] md:px-11">
      <div
        className="pointer-events-none absolute bottom-20 left-[244px] top-[26px] hidden w-px bg-[#ececec] md:block"
        aria-hidden
      />

      <aside className="sticky top-24 hidden h-fit md:block">
        <LeftRail />
      </aside>

      <main className="min-w-0">
        <RanksLadder />
      </main>
    </div>
  );
}
