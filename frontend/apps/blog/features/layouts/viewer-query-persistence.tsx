'use client';

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import { clearViewerQueries, persistViewerQueries, restoreViewerQueries } from '@/blog/lib/viewer-query-persist';

/**
 * Renders nothing. Restores the reader's saved results after hydration and keeps saving
 * them (see lib/viewer-query-persist.ts). Mounted as the FIRST child inside the user
 * providers: passive effects run in tree order, so this restore lands before the data hooks
 * below it subscribe and decide whether to fetch, and after React has hydrated the server
 * HTML, so nothing on the first client render differs from what the server sent.
 */
export default function ViewerQueryPersistence() {
  const queryClient = useQueryClient();
  const identity = useSessionIdentity();
  const viewer = identity.isLoggedIn ? identity.username : '';
  useEffect(() => {
    if (!viewer) {
      clearViewerQueries();
      return;
    }
    restoreViewerQueries(queryClient, viewer);
    return persistViewerQueries(queryClient, viewer);
  }, [queryClient, viewer]);
  return null;
}
