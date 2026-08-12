import { cn } from '@ui/lib/utils';

/**
 * ★ THE SMALL HALF OF THE "FIRST LIGHT" LOADING LANGUAGE (2026-08-12).
 *
 * The composed skeletons that drew a whole ghost post or comment are gone, replaced
 * by `LumenLoader`. This primitive stays, because the two jobs are genuinely
 * different: a single-line placeholder for one number in a stats bar should not
 * become a radiating light bloom, and dropping it would leave those slots collapsing
 * to zero height and jumping when the value lands.
 *
 * What changed is what it looks like while it waits. It was
 * `animate-pulse rounded-md bg-muted` — a cool grey block dimming in place, which is
 * both the wrong temperature for Lumen's cream stock and a different idea of motion
 * from everything around it. It now uses warm stock with light TRAVELLING across it:
 * the same "light leaving a source" idea as the loader, in one dimension instead of
 * two. See `packages/tailwindcss/globals.css` for the mechanics and the palette.
 *
 * Nothing about the API changed, so every existing `<Skeleton className="h-4 w-20" />`
 * across the two apps upgrades without being touched — which is the point. A visual
 * language that has to be applied file by file is one that gets applied to the feed
 * and forgotten on the profile tabs.
 */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('lumen-shimmer rounded-md', className)} {...props} />;
}

export { Skeleton };
