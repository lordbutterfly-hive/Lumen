'use client';

import { useEffect, useState } from 'react';
import { CircleSpinner } from 'react-spinners-kit';
import { useTranslation } from '@/blog/i18n/client';

/**
 * Time-aware banner shown for optimistic (unindexed) posts.
 * Updates messaging based on elapsed time since the post was created.
 *
 * - 0-10s: "Publishing..."
 * - 10-30s: "Confirmed on blockchain. Waiting for indexing..."
 * - 30s+: "Indexing is taking longer than usual..."
 *
 * ★ THE THIRD MESSAGE STOPS BEING TRUE, AND IT NEVER STOPS BEING SHOWN.
 *
 * It escalates on elapsed time alone, so anything older than 30 seconds claims
 * "Indexing is taking longer than usual. This is normal during high traffic."
 * — forever. A UX tester found it on a FOUR-HOUR-OLD post, shown to every
 * visitor including anonymous ones. For a Lumen post it is also the wrong
 * story: nothing is stuck indexing, the post is queued for the proxy account to
 * publish, and it is already readable here. Say that instead, and only claim
 * "unusual" inside a window where it can still be true.
 */
export default function OptimisticStatusBanner({
  createdAt,
  lite = false
}: {
  createdAt: string;
  /** A Lumen post awaiting its proxy publish, rather than a chain post awaiting indexing. */
  lite?: boolean;
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

  let message: string;
  if (elapsedSeconds < 10) {
    message = t('global.publishing');
  } else if (lite) {
    // Not indexing, and not a problem: it is waiting its turn to be broadcast.
    message = t('global.publish_queued');
  } else if (elapsedSeconds < 30) {
    message = t('global.confirmed_indexing');
  } else if (elapsedSeconds < 300) {
    message = t('global.indexing_slow');
  } else {
    // Past five minutes "taking longer than usual" is no longer information.
    message = t('global.publish_queued');
  }

  return (
    <div className="my-2 flex items-center gap-2 rounded-md border border-blue-400/50 bg-blue-50 px-3 py-2 text-sm text-blue-700">
      <CircleSpinner size={14} color="#3b82f6" loading />
      <span>{message}</span>
    </div>
  );
}
