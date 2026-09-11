'use client';

import { ReactNode } from 'react';
import LeftRail from '@/blog/features/layouts/left-rail';
import BasePathLink from '@/blog/components/base-path-link';

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
/**
 * ★ THE BACK SLOT (A5, 2026-08-23). Every creator-token route rendered this shell with no
 * way out except the logo, which drops the reader on the home feed and costs them their
 * place — the same trap `/security` had. One slot here gives the token page, the studio and
 * the launch wizard a consistent exit instead of three bespoke ones.
 *
 * Optional, and absent by default, so no existing caller changes shape. Verified before
 * adding: none of the three routes carries a `PageMasthead` or any other shell-level back,
 * so this produces exactly ONE back affordance per route and never a second one beside an
 * existing control. The launch wizard's in-wizard Back moves between STEPS; this leaves the
 * feature, and the two do not collide.
 */
export default function TokenShell({
  children,
  rightRail,
  back
}: {
  children: ReactNode;
  rightRail?: ReactNode;
  back?: { href: string; label: string };
}) {
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
      <main className="min-w-0">
        {back ? (
          <BasePathLink
            href={back.href}
            className="mb-4 inline-block font-ui text-[14px] leading-[22px] font-medium text-ink-brand-6 transition-colors hover:text-ink-brand-4"
            data-testid="creator-back"
          >
            {back.label}
          </BasePathLink>
        ) : null}
        {children}
      </main>
      {rightRail ? (
        <aside className="sticky top-24 hidden h-fit bg-background-secondary xl:block">{rightRail}</aside>
      ) : null}
    </div>
  );
}
