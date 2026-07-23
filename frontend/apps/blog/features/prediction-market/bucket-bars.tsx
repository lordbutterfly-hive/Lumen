import { cn } from '@ui/lib/utils';
import type { Bucket } from './types';
import { buildOutcomeColorMap } from './outcome-colors';

// The "Pool odds" ladder: one row per outcome = label + bar (width = pool share)
// + the share as ¢. The ¢ value IS the outcome's implied probability
// (bucket.oddsPct = its slice of the pool) — parimutuel payout genuinely is
// stake ÷ final share, so this is honest. NOT a fixed-odds "contract price".
//
// Renders N buckets generically (no hard-coded count). `full` = the centre card
// ladder; `compact` = the right-rail widget (adds a colour dot, thinner track).
export default function BucketBars({ buckets, size = 'compact' }: { buckets: Bucket[]; size?: 'compact' | 'full' }) {
  const colors = buildOutcomeColorMap(buckets);
  const full = size === 'full';

  return (
    <ul className={cn('flex flex-col', full ? 'gap-3' : 'gap-[9px]')}>
      {buckets.map((bucket) => {
        const color = colors[bucket.id];
        return (
          <li key={bucket.id} className="flex items-center gap-2.5">
            {!full && (
              <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />
            )}
            <span
              className={cn(
                'flex-shrink-0 font-sans',
                full ? 'w-28 text-[13.5px] font-medium text-[#374151]' : 'w-24 text-[12.5px] text-[#3f4650]'
              )}
            >
              {bucket.label}
            </span>
            <span
              className={cn(
                'relative flex-1 overflow-hidden rounded-md bg-[#f1f3f5]',
                full ? 'h-2' : 'h-1.5 rounded-[5px]'
              )}
            >
              <span
                className={cn('absolute inset-y-0 left-0 rounded-md', !full && 'rounded-[5px]')}
                style={{ width: `${Math.max(bucket.oddsPct, 1.5)}%`, backgroundColor: color }}
              />
            </span>
            <span
              className={cn(
                'flex-shrink-0 text-right font-sans font-bold tabular-nums text-[#161511]',
                full ? 'w-9 text-[13.5px]' : 'w-[30px] text-xs'
              )}
            >
              {bucket.oddsPct}¢
            </span>
          </li>
        );
      })}
    </ul>
  );
}
