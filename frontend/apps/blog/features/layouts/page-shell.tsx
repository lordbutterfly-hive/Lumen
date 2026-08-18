'use client';

import { ReactNode } from 'react';
import LeftRail from './left-rail';
import RightRail from './right-rail';
import { StreakCardNarrow } from '@/blog/features/retention/components/streak-card';

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
  rightRailExtra,
  mainClassName = 'min-w-0'
}: {
  children: ReactNode;
  /** Omit for the default `<RightRail />` (every reading surface gets this).
   *  Pass `null` to drop the right rail and its grid column entirely
   *  (settings does this — it is account housekeeping, not a reading surface). */
  rightRail?: ReactNode;
  /**
   * Extra content stacked below the rail in the sticky RIGHT column — the post
   * page's "You Might Also Like" suggestion list lives here.
   *
   * ★ THIS USED TO BE `leftRailExtra`, IN THE LEFT COLUMN (2026-08-13, audit
   * §6). Measured on the shipped build: the panel sat in the 200px left aside
   * alongside the primary navigation, as an `overflow-y-auto` scroller
   * (`clientHeight 687` / `scrollHeight 1976`) inside a `md:sticky md:top-24`
   * panel inside the `sticky top-24` aside. Two stickies at the SAME offset can
   * never move relative to each other, so the inner one bought nothing and only
   * created a second scroll context; and its `overscroll-behavior: auto` chained
   * the wheel to the page the moment the inner scroller bottomed out — which is
   * exactly the "it scrolls that part AND the page" complaint. The right column
   * already computes to a real 312px track at this viewport (measured
   * `200px 846px 312px` at 1534px wide), so discovery content no longer has to
   * fight the navigation for the narrowest column on the page.
   */
  rightRailExtra?: ReactNode;
  mainClassName?: string;
}) {
  const rail = rightRail === undefined ? <RightRail /> : rightRail;
  /**
   * ★ ONLY WHEN THIS SHELL IS USING THE DEFAULT RAIL. A caller that passed
   * `rightRail={null}` (/settings does) declined the feed rail; it did not ask for the
   * rail's contents to reappear inside the content column at narrow widths instead.
   */
  const usesDefaultRail = rightRail === undefined;
  // The right COLUMN exists if anything at all wants to live in it. Keeping this
  // as one condition means `rightRailExtra` can never be silently dropped by a
  // caller that also passed `rightRail={null}`.
  const hasRightColumn = !!rail || !!rightRailExtra;

  return (
    <div
      className={`relative mx-auto grid max-w-[1720px] grid-cols-1 gap-11 px-6 pb-20 pt-[26px] md:grid-cols-[200px_minmax(0,1fr)] md:px-11 ${
        hasRightColumn ? 'xl:grid-cols-[200px_minmax(0,1fr)_312px]' : ''
      }`}
    >
      <div
        className="pointer-events-none absolute bottom-20 left-[244px] top-[26px] hidden w-px bg-surface-26 md:block"
        aria-hidden
      />

      <aside className="sticky top-24 hidden h-fit bg-background-secondary md:block">
        <LeftRail />
      </aside>

      <main className={mainClassName}>
        {usesDefaultRail ? <StreakCardNarrow /> : null}
        {children}
      </main>

      {/* ONE sticky, on the column wrapper, at ONE offset. Nothing inside this
          column may add a second `sticky` or its own scroller — see the
          `rightRailExtra` note above for what that cost the last time. */}
      {hasRightColumn ? (
        <aside className="sticky top-24 hidden h-fit flex-col gap-5 bg-background-secondary xl:flex">
          {rail}
          {rightRailExtra}
        </aside>
      ) : null}
    </div>
  );
}
