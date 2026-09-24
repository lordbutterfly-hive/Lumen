import type { RankMarksRecord, RankMarksSeed } from '@/blog/components/observer-provider';

/**
 * ★ THE SERVER'S ANSWER, WHEN IT COVERS THIS LIST (2026-09-24). A page that read the marks on
 * the server (`seedRankMarks` in lib/rank-marks-read.ts, home today) passes them to
 * `useRankMarks`/`useRankLuminosity`, and when every account in `key` was among the accounts
 * the server ASKED, that answer becomes the query's `initialData`: the marks are in the
 * server HTML and no `/api/streak/marks` call is made while it is fresh. Absent accounts
 * stay absent ("no mark"), exactly as the route answers them. Any account the server did
 * not ask (a later infinite-scroll page, a post the silent poll added) means no seed, and
 * the query fetches as it always did.
 *
 * Pure (type imports only) so the unit runner can load it; `key` is the hooks' own sorted,
 * lowercased, deduped author list.
 */
export function seededRankMarks(key: string[], seed?: RankMarksSeed | null): { marks: RankMarksRecord } | undefined {
  if (!seed || key.length === 0) return undefined;
  const asked = new Set(seed.accounts);
  if (!key.every((a) => asked.has(a))) return undefined;
  const marks: RankMarksRecord = {};
  for (const a of key) if (seed.marks[a]) marks[a] = seed.marks[a];
  return { marks };
}
