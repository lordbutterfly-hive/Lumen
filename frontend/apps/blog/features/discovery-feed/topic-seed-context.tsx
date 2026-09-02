'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { Entry } from '@hive/common-hiveio-packages/wax';

/**
 * The topic page's server seed (snappiness phase 4, 2026-09-03): the first
 * page of the topic feed as the server had it in its cache at render time,
 * handed to TopicShell as React Query `initialData`. Same idea, same shape and
 * same freshness stamp as home's InitialFeedProvider (components/observer-provider.tsx).
 * `null` means the topic was cold on the server and the client fetches as before.
 */
export interface TopicSeedPage {
  entries: Entry[];
  source: string;
  degraded?: string;
  nextCursor?: { author: string; permlink: string } | null;
}

export interface TopicSeed {
  page: TopicSeedPage;
  at: number;
}

const TopicSeedContext = createContext<TopicSeed | null>(null);

export const TopicSeedProvider = ({ value, children }: { value: TopicSeed | null; children: ReactNode }) => (
  <TopicSeedContext.Provider value={value}>{children}</TopicSeedContext.Provider>
);

export const useTopicSeed = () => useContext(TopicSeedContext);
