'use client';

import { ReactNode } from 'react';
import LeftRail from '@/blog/features/layouts/left-rail';

/**
 * Shared three-column shell for the creator-token screens — identical grid to
 * `discovery-feed/home-shell` (200 / 1fr / 312, gap 44, max-w 1720, centered,
 * 1px divider at the nav's right edge) so every page lines up pixel-for-pixel.
 * The top `AppHeader` comes from the root layout; this is the body only.
 */
/**
 * ★ THE 312px RAIL IS ONLY RESERVED WHEN SOMETHING FILLS IT (2026-08-17).
 *
 * The third column was hardcoded into the grid and always rendered, holding
 * `undefined` for any caller that passes no `rightRail`. The launch wizard is one
 * of those, so ~312px of every wide viewport was reserved for an empty aside while
 * the wizard's own content squeezed beside it — about 40% of the screen given to a
 * static panel and a column with nothing in it.
 *
 * Mirrors `profile-subpage-shell.tsx`, which already drops its rail this way. Every
 * existing caller keeps its exact layout: the three-column class and the aside both
 * key off the SAME `rightRail` truthiness, so a caller that passes one is unchanged
 * and a caller that never did simply stops paying for it.
 */
export default function TokenShell({ children, rightRail }: { children: ReactNode; rightRail?: ReactNode }) {
  return (
    <div
      className={`relative mx-auto grid max-w-[1720px] grid-cols-1 gap-11 px-6 pb-20 pt-[26px] md:grid-cols-[200px_minmax(0,1fr)] md:px-11 ${
        rightRail ? 'xl:grid-cols-[200px_minmax(0,1fr)_312px]' : ''
      }`}
    >
      <div
        className="pointer-events-none absolute bottom-20 left-[244px] top-[26px] hidden w-px bg-surface-26 md:block"
        aria-hidden
      />
      <aside className="sticky top-24 hidden h-fit bg-background-secondary md:block">
        <LeftRail />
      </aside>
      <main className="min-w-0">{children}</main>
      {rightRail ? (
        <aside className="sticky top-24 hidden h-fit bg-background-secondary xl:block">{rightRail}</aside>
      ) : null}
    </div>
  );
}
