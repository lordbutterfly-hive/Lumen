'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import { fetchPostStatus } from '@/blog/lib/chain-fetch';
import { CircleSpinner } from 'react-spinners-kit';
import { Icons } from '@ui/components/icons';
import { Button } from '@ui/components/button';
import { useTranslation } from '@/blog/i18n/client';

/**
 * Shown when navigating to a just-created post (?pending=1) but
 * optimistic data is not available in the React Query cache
 * (e.g., user opened URL in a new tab, or cache was GC'd).
 *
 * Polls Hivemind until the post is indexed, then reloads with real data.
 */
export default function PendingIndexingMessage({
  author,
  permlink,
  observer
}: {
  author: string;
  permlink: string;
  observer: string;
}) {
  const { t } = useTranslation('common_blog');
  const router = useRouter();
  const pathname = usePathname();
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    const start = Date.now();
    const interval = setInterval(() => setElapsedSeconds(Math.floor((Date.now() - start) / 1000)), 5000);
    return () => clearInterval(interval);
  }, []);

  const hasTimedOut = elapsedSeconds >= 180;

  // ★ THROUGH OUR SERVER, NOT THE CHAIN CLIENT (2026-08-12). This polled
  // `getPost` directly, every 10s for up to 180s — each poll downloaded
  // `wax.common.wasm` on first call. See
  // `apps/blog/app/api/post-status/route.ts`.
  const { data: postStatus } = useQuery({
    queryKey: ['pendingPostPoll', author, permlink, observer],
    queryFn: () => fetchPostStatus(author, permlink, observer),
    refetchInterval: hasTimedOut ? false : 10000,
    enabled: !hasTimedOut
  });
  const postData = postStatus?.post ?? null;

  // Post appeared in Hivemind — strip ?pending and reload with real data
  useEffect(() => {
    if (postData && pathname) {
      router.replace(pathname);
    }
  }, [postData, router, pathname]);

  let message: string;
  if (hasTimedOut) {
    message = t('global.indexing_timeout');
  } else if (elapsedSeconds < 30) {
    message = t('global.confirmed_indexing');
  } else {
    message = t('global.indexing_slow');
  }

  return (
    <div className="mx-auto flex flex-col items-center py-8" data-testid="pending-indexing-message">
      <Icons.hive className="h-16 w-16" />
      <div className="my-4 flex items-center gap-2">
        {!hasTimedOut && <CircleSpinner size={18} color="#3b82f6" loading />}
        <h3 className="text-lg">{message}</h3>
      </div>
      {elapsedSeconds >= 120 && (
        <Button variant="outline" onClick={() => router.refresh()} className="mt-2">
          {t('global.reload_page')}
        </Button>
      )}
    </div>
  );
}
