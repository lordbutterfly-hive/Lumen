'use client';

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { mockSummary } from '../lib/mock-summary';
import type { RetentionSummary } from '../types';

// Data source for the retention summary.
//
// TWO LAYERS, TWO OWNERS (the anti-farm invariant, expressed as architecture):
//   - LEAGUE (tier, division, standing, gate meters, tenure, streak, active
//     weeks) is CHAIN-DERIVED and comes from /api/streak/[user]. None of it can
//     be self-inflated because none of it is client-supplied.
//   - HABIT (level, XP, daily tasks) is cosmetic and partly forgeable by design
//     ("showed up", "read something"), so it stays client-side. Until the local
//     task ledger is wired, the habit layer is served from the mock.
//
// Set NEXT_PUBLIC_RETENTION_SOURCE=api to use the real route. Anything else
// keeps the pure mock, so the UI still builds and demos with no backend.
const RETENTION_SOURCE = process.env.NEXT_PUBLIC_RETENTION_SOURCE;

interface ServerSummary {
  username: string;
  rank: RetentionSummary['rank'];
  gate: RetentionSummary['gate'];
  tenureYear: number;
  streakDays: number;
  activeWeeks: number;
}

async function fetchRetention(username: string): Promise<RetentionSummary> {
  const local = mockSummary(username);
  if (RETENTION_SOURCE !== 'api') return local;

  const res = await fetch(`/api/streak/${encodeURIComponent(username)}`);
  if (!res.ok) throw new Error(`retention fetch failed: ${res.status}`);
  const server = (await res.json()) as ServerSummary;

  return {
    username: server.username,
    rank: server.rank,
    gate: server.gate,
    tenureYear: server.tenureYear,
    // Habit stays local; the two chain-derived members of it are overwritten
    // with the server's factual values rather than the mock's.
    habit: { ...local.habit, streakDays: server.streakDays, activeWeeks: server.activeWeeks },
    tasks: local.tasks
  };
}

export function useRetention(username: string): UseQueryResult<RetentionSummary> {
  return useQuery({
    queryKey: ['retention', username, RETENTION_SOURCE ?? 'mock'],
    queryFn: () => fetchRetention(username),
    enabled: Boolean(username),
    staleTime: 5 * 60 * 1000,
    // On a failed chain read we deliberately do NOT fall back to the mock: the
    // consumers all render null without data, so the block disappears rather
    // than showing a fabricated tier. A wrong status is worse than no status.
    retry: 1
  });
}
