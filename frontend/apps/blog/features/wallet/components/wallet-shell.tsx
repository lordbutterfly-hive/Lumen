import LeftRail from '@/blog/features/layouts/left-rail';
import WalletContent from './wallet-content';
import WalletRightRail from './wallet-right-rail';

/**
 * Wallet page shell — same fixed 3-column grid as
 * features/discovery-feed/home-shell.tsx (200 / 1fr / 312, gap 44, max-width
 * 1720, symmetric 44px gutters, centered, both rails sticky/locked). Reuses
 * the shared LeftRail/RightRail slots but not home-shell itself, since the
 * center content and right rail are entirely different here.
 */
export default function WalletShell() {
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
        <WalletContent />
      </main>

      <aside className="sticky top-24 hidden h-fit bg-background-secondary xl:block">
        <WalletRightRail />
      </aside>
    </div>
  );
}
