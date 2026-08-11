'use client';

import { ReactNode } from 'react';
import LeftRail from './left-rail';
import RightRail from './right-rail';

/**
 * ★★★ THE ONE APP FRAME (F9, 2026-08-11, buildmap item 12 / P3 "container widths").
 *
 * Before this file existed, the identical grid string —
 * `relative mx-auto grid max-w-[1720px] grid-cols-1 gap-11 px-6 pb-20 pt-[26px]
 * md:grid-cols-[200px_minmax(0,1fr)] md:px-11 xl:grid-cols-[200px_minmax(0,1fr)_312px]`
 * — was hand-copied into at least SEVEN files: `main-page-layout.tsx`,
 * `user-profile/profile-subpage-shell.tsx`, `search/content.tsx`,
 * `creator-tokens/ui/token-shell.tsx`, `proposals/components/proposals-content.tsx`,
 * `discovery-feed/home-shell.tsx` and `witnesses/witnesses-shell.tsx`. That is not a
 * design inconsistency (every one of those renders the same 200/1fr/312 frame,
 * so those pages already agree with each other) — it is seven copies of one
 * component that was never extracted. This file is that extraction.
 *
 * The ONE page that did NOT match this frame was the post page: it built its own
 * unconstrained `grid-cols-12`, with no `max-w-[1720px]` cap, a proportional
 * (not fixed-200px) left column, and an empty `col-span-2` div standing in for a
 * right rail — which is exactly the "~300px of dead space on the right" in
 * buildmap item 12. That page now consumes this component too
 * (`app/[param]/[p2]/[permlink]/content.tsx`), which is the actual fix.
 *
 * Only `main-page-layout.tsx`, `user-profile/profile-subpage-shell.tsx` and
 * `search/content.tsx` were migrated onto this component in the same pass — the
 * other four (`token-shell.tsx`, `proposals-content.tsx`, `home-shell.tsx`,
 * `witnesses-shell.tsx`) belong to other jobs' explicit ownership (creator-tokens,
 * proposals, home feed, witnesses) and were left as their own local copies on
 * purpose, to avoid touching files outside this job's brief while multiple other
 * agents were editing this repo concurrently. They are candidates for the same
 * migration in a follow-up pass — see the F9 report for the full list.
 */
export default function PageShell({
  children,
  rightRail,
  leftRailExtra,
  mainClassName = 'min-w-0'
}: {
  children: ReactNode;
  /** Omit for the default `<RightRail />` (every reading surface gets this).
   *  Pass `null` to drop the right rail and its grid column entirely
   *  (settings does this — it is account housekeeping, not a reading surface). */
  rightRail?: ReactNode;
  /** Extra content stacked below the nav in the sticky left column (the post
   *  page's "You Might Also Like" suggestion list lives here). */
  leftRailExtra?: ReactNode;
  mainClassName?: string;
}) {
  const rail = rightRail === undefined ? <RightRail /> : rightRail;

  return (
    <div
      className={`relative mx-auto grid max-w-[1720px] grid-cols-1 gap-11 px-6 pb-20 pt-[26px] md:grid-cols-[200px_minmax(0,1fr)] md:px-11 ${
        rail ? 'xl:grid-cols-[200px_minmax(0,1fr)_312px]' : ''
      }`}
    >
      <div
        className="pointer-events-none absolute bottom-20 left-[244px] top-[26px] hidden w-px bg-[#ececec] md:block"
        aria-hidden
      />

      <aside className="sticky top-24 hidden h-fit md:block">
        <LeftRail />
        {leftRailExtra}
      </aside>

      <main className={mainClassName}>{children}</main>

      {rail ? <aside className="sticky top-24 hidden h-fit xl:block">{rail}</aside> : null}
    </div>
  );
}
