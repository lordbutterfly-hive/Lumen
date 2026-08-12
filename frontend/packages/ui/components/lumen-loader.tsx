import { cn } from '@ui/lib/utils';

/**
 * ★★★ THE LUMEN LOADING STATE — "first light".
 *
 * Replaces the inherited hive.blog/denser grey pulse skeletons everywhere they drew
 * a ghost POST, COMMENT, PROFILE or CARD. The full rationale — why a wrong skeleton
 * is worse than none, and what each detail of the motion is doing — lives with the
 * CSS in `packages/tailwindcss/globals.css`, because that is where anyone editing
 * the animation will actually be standing.
 *
 * ★ NO `'use client'`, DELIBERATELY. This is pure CSS with no state, no effects and
 * no handlers, so it renders as a server component and the route `loading.tsx` files
 * that use it ship ZERO extra JavaScript. That matters more than usual here: the
 * whole point of a loading boundary is to paint before the client bundle has
 * arrived, and a loader that needs hydrating to appear cannot do its own job.
 *
 * ★ IT DOES NOT RESERVE THE CONTENT'S SHAPE, AND THAT IS THE TRADE. A skeleton that
 * genuinely mirrors the final layout beats this; ours had stopped doing that at the
 * redesign and was flashing a stale shape, so the honest option was to stop
 * pretending. What this still owes the page is HEIGHT, so the arrival of real
 * content does not yank the scroll position — hence `minHeight`, and hence callers
 * passing the height of the region they are standing in rather than accepting a
 * one-size default.
 */

export type LumenLoaderSize = 'sm' | 'md' | 'lg';

/** Ring diameter at full expansion. The ember, bloom and glow all derive from it. */
const SIZE_PX: Record<LumenLoaderSize, string> = {
  sm: '44px',
  md: '76px',
  lg: '104px'
};

/**
 * Vertical space held while loading. Not decoration: content arriving into a box
 * that was too short pushes everything below it down, which on a feed means the
 * reader loses their place at the exact moment they were about to start reading.
 *
 * ★ A CLASS, NOT AN INLINE STYLE, AND FOR ONE SPECIFIC REASON. `className` runs
 * through `cn` (tailwind-merge), so a caller passing `min-h-[520px]` REPLACES this
 * default. An inline `minHeight` would have won against it silently, making the
 * documented override quietly not work — the sort of thing nobody notices until a
 * page is mysteriously the wrong height.
 */
const MIN_HEIGHT: Record<LumenLoaderSize, string> = {
  sm: 'min-h-[88px]',
  md: 'min-h-[260px]',
  lg: 'min-h-[420px]'
};

export interface LumenLoaderProps {
  size?: LumenLoaderSize;
  /** Applied to the outer box — use it to override the reserved height or padding. */
  className?: string;
  /**
   * Screen-reader-only announcement. Optional because `@hive/ui` has no access to
   * the blog's `t()`, and an English string hardcoded into a shared package would
   * be worse than silence in eight of our nine locales — callers that have
   * translations pass `t('global.loading')`, callers that do not stay quiet and
   * rely on `aria-busy` alone, which is the correct signal either way.
   */
  label?: string;
}

const LumenLoader = ({ size = 'md', className, label }: LumenLoaderProps) => (
  <div
    role="status"
    aria-busy="true"
    aria-live="polite"
    data-testid="lumen-loader"
    className={cn('lumen-loader w-full', MIN_HEIGHT[size], className)}
    style={{ '--lumen-size': SIZE_PX[size] } as React.CSSProperties}
  >
    <span className="lumen-loader__bloom" aria-hidden="true" />
    <span className="lumen-loader__ring lumen-loader__ring--1" aria-hidden="true" />
    <span className="lumen-loader__ring lumen-loader__ring--2" aria-hidden="true" />
    <span className="lumen-loader__ring lumen-loader__ring--3" aria-hidden="true" />
    <span className="lumen-loader__comet" aria-hidden="true" />
    <span className="lumen-loader__ember" aria-hidden="true" />
    {label ? <span className="sr-only">{label}</span> : null}
  </div>
);

export { LumenLoader };
export default LumenLoader;
