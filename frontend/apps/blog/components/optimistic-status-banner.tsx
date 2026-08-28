'use client';

import { useEffect, useState } from 'react';
import { CircleSpinner } from 'react-spinners-kit';
import { cn } from '@hive/ui/lib/utils';
import { useTranslation } from '@/blog/i18n/client';
import {
  getPublishBadgeState,
  PUBLISH_BADGE_COPY_KEY,
  publishBadgeShowsSpinner
} from '@/blog/lib/publish-badge-state';

/**
 * Time-aware banner shown for optimistic (unindexed) posts.
 *
 * CHAIN branch (a post just broadcast from this browser, waiting to be indexed):
 * - 0-10s: "Publishing..."
 * - 10-30s: "Confirmed on blockchain. Waiting for indexing..."
 * - 30s-5m: "Indexing is taking longer than usual..."
 * - 5m+: the neutral queued line
 *
 * ★ THE THIRD MESSAGE STOPS BEING TRUE, AND IT NEVER STOPS BEING SHOWN.
 *
 * It escalated on elapsed time alone, so anything older than 30 seconds claimed
 * "Indexing is taking longer than usual. This is normal during high traffic."
 * — forever. A UX tester found it on a FOUR-HOUR-OLD post, shown to every
 * visitor including anonymous ones. For a Lumen post it is also the wrong
 * story: nothing is stuck indexing, the post is queued for the proxy account to
 * publish, and it is already readable here. Say that instead, and only claim
 * "unusual" inside a window where it can still be true.
 *
 * ★★★ AND THE LITE BRANCH HAD EXACTLY THE SAME DEFECT, UNFIXED (2026-08-28,
 * false-text audit F10). Every Lumen post older than ten seconds rendered
 * "Saved and visible on Lumen. It will appear on Hive shortly." with no ladder,
 * no terminal state and no failure input — so "shortly" stayed on screen for
 * days, on a publisher that is stalled on resource credits with the oldest job
 * hours old (`app/api/lite/posts/replies/route.ts`). The fix above was written
 * for the chain branch of this same function and never swept to the branch
 * directly beside it.
 *
 * The ladder now comes from `lib/publish-badge-state.ts`, which is the module
 * `features/post-rendering/comment-list-item.tsx` already used and got right:
 * queued (15 minutes) to waiting (6 hours) to delayed, with `failed` outranking
 * every age-based state. Both renderers import it, so neither can drift again.
 */
export default function OptimisticStatusBanner({
  createdAt,
  lite = false,
  publishFailed = false
}: {
  createdAt: string;
  /** A Lumen post awaiting its proxy publish, rather than a chain post awaiting indexing. */
  lite?: boolean;
  /**
   * The publish is exhausted and will not land without a human. Absent means
   * unknown, never "fine" — the same contract as `Entry._publishFailed`.
   */
  publishFailed?: boolean;
}) {
  const { t } = useTranslation('common_blog');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    const createdTime = new Date(createdAt).getTime();
    const update = () => setElapsedSeconds(Math.floor((Date.now() - createdTime) / 1000));
    update();
    const interval = setInterval(update, 5000);
    return () => clearInterval(interval);
  }, [createdAt]);

  // `elapsedSeconds` drives the re-render on the 5s tick; the lite ladder reads
  // the clock again itself, inside `getPublishBadgeState`.
  const ladderState = getPublishBadgeState(true, lite, createdAt, publishFailed);

  let message: string;
  let showSpinner: boolean;
  if (ladderState === 'failed') {
    // Outranks age on both branches. A post whose publish is exhausted must not
    // be told it is about to land.
    message = t(PUBLISH_BADGE_COPY_KEY.failed);
    showSpinner = false;
  } else if (elapsedSeconds < 10) {
    message = t('global.publishing');
    showSpinner = true;
  } else if (lite) {
    // queued -> waiting -> delayed, and every one of them is true when shown.
    message = t(PUBLISH_BADGE_COPY_KEY[ladderState ?? 'queued']);
    showSpinner = publishBadgeShowsSpinner(ladderState);
  } else if (elapsedSeconds < 30) {
    message = t('global.confirmed_indexing');
    showSpinner = true;
  } else if (elapsedSeconds < 300) {
    message = t('global.indexing_slow');
    showSpinner = true;
  } else {
    // Past five minutes "taking longer than usual" is no longer information.
    // ★ AND THIS BRANCH USED `global.publish_queued` — "Saved and visible on
    // Lumen. It will appear on Hive shortly." — on a CHAIN post, which was
    // already on Hive and was never queued for anything (2026-08-28, swept with
    // F10). Same "shortly" promise, same never-stops-being-shown shape, one
    // branch over. It now says the true thing: broadcast, awaiting the index.
    message = t('global.indexing_pending');
    showSpinner = false;
  }

  const failed = ladderState === 'failed';

  return (
    <div
      className={cn('my-2 flex items-center gap-2 rounded-md border px-3 py-2 text-sm', {
        'border-line-info-2/50 bg-surface-info-1 text-ink-info-2': !failed,
        'border-destructive/50 bg-surface-1 text-destructive': failed
      })}
      data-testid="optimistic-status-banner"
      data-publish-state={failed ? 'failed' : lite ? ladderState : 'chain'}
    >
      {showSpinner ? <CircleSpinner size={14} color="#3b82f6" loading /> : null}
      <span>{message}</span>
    </div>
  );
}
