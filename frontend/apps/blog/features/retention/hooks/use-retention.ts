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
  // Default to the REAL chain-derived route; only fall back to the demo mock when
  // explicitly asked (NEXT_PUBLIC_RETENTION_SOURCE=mock) — never show fabricated
  // rank/XP as if it were the user's own (N3).
  if (RETENTION_SOURCE === 'mock') return { ...local, habitSource: 'mock' };

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
    tasks: local.tasks,
    // streakDays/activeWeeks above ARE real; level/XP/tasks are still the mock's
    // constants, so the layer is flagged 'mock' until a task ledger exists.
    habitSource: 'mock' as const
  };
}

/**
 * ★ A LUMEN LITE ACCOUNT HAS NO CHAIN TENURE, SO THERE IS NOTHING TO ASK FOR.
 *
 * `/api/streak/[user]` derives rank, streak and active weeks from the CHAIN, and
 * answers `404 account not found` for a name that has no Hive account. Four of
 * six UX testers independently noticed it firing — and failing — on essentially
 * every page load, with no streak UI anywhere on screen to show for it. The
 * consumers already render nothing without data, so the only thing the call was
 * producing was load: this is the route that was once measured taking 639
 * seconds, and it was being issued for readers it can never answer.
 *
 * `chainAccount` defaults to true so existing callers keep their behaviour; the
 * profile passes the account's real tier.
 */
export function useRetention(username: string, chainAccount = true): UseQueryResult<RetentionSummary> {
  return useQuery({
    queryKey: ['retention', username, RETENTION_SOURCE ?? 'mock'],
    queryFn: () => fetchRetention(username),
    enabled: Boolean(username) && chainAccount,
    staleTime: 5 * 60 * 1000,
    // On a failed chain read we deliberately do NOT fall back to the mock: the
    // consumers all render null without data, so the block disappears rather
    // than showing a fabricated tier. A wrong status is worse than no status.
    retry: 1
  });
}
