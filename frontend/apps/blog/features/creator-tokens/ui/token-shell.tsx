'use client';

import { ReactNode } from 'react';
import LeftRail from '@/blog/features/layouts/left-rail';

/**
 * Shared three-column shell for the creator-token screens — identical grid to
 * `discovery-feed/home-shell` (200 / 1fr / 312, gap 44, max-w 1720, centered,
 * 1px divider at the nav's right edge) so every page lines up pixel-for-pixel.
 * The top `AppHeader` comes from the root layout; this is the body only.
 */
export default function TokenShell({ children, rightRail }: { children: ReactNode; rightRail?: ReactNode }) {
  return (
    <div className="relative mx-auto grid max-w-[1720px] grid-cols-1 gap-11 px-6 pb-20 pt-[26px] md:grid-cols-[200px_minmax(0,1fr)] md:px-11 xl:grid-cols-[200px_minmax(0,1fr)_312px]">
      <div
        className="pointer-events-none absolute bottom-20 left-[244px] top-[26px] hidden w-px bg-surface-26 md:block"
        aria-hidden
      />
      <aside className="sticky top-24 hidden h-fit bg-background-secondary md:block">
        <LeftRail />
      </aside>
      <main className="min-w-0">{children}</main>
      <aside className="sticky top-24 hidden h-fit bg-background-secondary xl:block">{rightRail}</aside>
    </div>
  );
}
