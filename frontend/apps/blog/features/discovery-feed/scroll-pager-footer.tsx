'use client';

import { useTranslation } from '@/blog/i18n/client';
import type { InfiniteScrollSentinel } from './hooks/use-infinite-scroll-sentinel';

/**
 * The end of an infinite list, in one place.
 *
 * Three states on ONE element, so the sentinel node never unmounts and
 * remounts under the observer:
 *   - paging      -> an unlabelled sentinel (plus "Loading more…" while a fetch runs)
 *   - at the cap  -> "Load more" and "Back to top", the only two things a reader
 *                    at the bottom of 150 posts actually wants
 *   - exhausted   -> the caller's own "that's everything" line, passed as `endLabel`
 *
 * ★ WHY "Back to top" IS HERE AND NOT IN THE HEADER. It is only ever needed by
 * someone who is thousands of pixels down a list this component is the bottom
 * of. Putting it anywhere else would mean a floating control on every page.
 */
export default function ScrollPagerFooter({
  sentinel,
  hasNextPage,
  isFetchingNextPage,
  isError = false,
  loadedCount,
  endLabel,
  loadingLabel = 'Loading…',
  className = 'py-8 text-center font-sans text-[13px] leading-[20px] text-muted-foreground',
  testId
}: {
  sentinel: InfiniteScrollSentinel;
  hasNextPage: boolean | undefined;
  isFetchingNextPage: boolean;
  /**
   * The last page fetch failed. Auto-paging stops on this (see the hook) —
   * which used to mean a silent dead end, so this offers the way out.
   */
  isError?: boolean;
  /** How many items are currently held, for the honest "you have N" line. */
  loadedCount?: number;
  /** Rendered when there is genuinely nothing more upstream. */
  endLabel?: string;
  loadingLabel?: string;
  className?: string;
  testId?: string;
}) {
  const { t } = useTranslation('common_blog');
  const { ref, atPageCap, loadMore, backToTop, retry } = sentinel;

  if (!hasNextPage) {
    return endLabel ? (
      <p className={className} data-testid={testId ? `${testId}-end` : undefined}>
        {endLabel}
      </p>
    ) : null;
  }

  return (
    <div ref={ref} className={className} data-testid={testId}>
      {isError && !isFetchingNextPage ? (
        <button
          type="button"
          onClick={retry}
          data-testid={testId ? `${testId}-retry` : undefined}
          className="font-sans text-sm text-muted-foreground underline hover:text-foreground"
        >
          {t('user_profile.load_failed_retry')}
        </button>
      ) : atPageCap ? (
        <div className="flex flex-col items-center gap-2">
          {typeof loadedCount === 'number' ? (
            <span className="tabular-nums">Showing the first {loadedCount}.</span>
          ) : null}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={loadMore}
              data-testid={testId ? `${testId}-load-more` : undefined}
              className="rounded-[13px] bg-[#c0392b] px-5 py-2.5 font-sans text-[14px] leading-[22px] font-semibold text-white transition-colors hover:bg-[#a5301f]"
            >
              Load more
            </button>
            <button
              type="button"
              onClick={backToTop}
              data-testid={testId ? `${testId}-back-to-top` : undefined}
              className="rounded-[13px] border border-[#e4e6e9] px-5 py-2.5 font-sans text-[14px] leading-[22px] font-semibold text-[#3f4650] transition-colors hover:bg-[#f6f7f8]"
            >
              Back to top
            </button>
          </div>
        </div>
      ) : isFetchingNextPage ? (
        loadingLabel
      ) : (
        ''
      )}
    </div>
  );
}
