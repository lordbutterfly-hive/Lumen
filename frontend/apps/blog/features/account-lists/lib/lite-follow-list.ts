import type { IFollow } from '@hive/common-hiveio-packages/wax';

/**
 * ★★★ FALL BACK TO LUMEN'S OWN FOLLOW GRAPH.
 *
 * `condenser_api.get_following` / `get_followers` only know the CHAIN's follow
 * graph, keyed on real Hive accounts. Lumen carries three follow directions the
 * chain cannot — lite→lite, lite→Hive and Hive→lite — in its own table.
 *
 * So the Followers/Following pages showed a lite account an accurate header
 * count (read from that table) above a list body that was permanently empty
 * (read from the chain). Two numbers, two stores, one of them unrenderable.
 * Found by an exploratory UX tester 2026-08-06, who cross-checked it three ways
 * including a direct `get_accounts` call proving the handle has no chain
 * account at all.
 *
 * Deliberately a FALLBACK rather than a branch on account type: the caller does
 * not always know the tier, an upgraded account legitimately has edges in both
 * stores, and "the chain returned nothing" is the exact condition under which
 * Lumen's own graph is worth consulting. Same shape either way, so no consumer
 * has to learn about tiers.
 */
export async function liteFollowList(
  account: string,
  type: 'following' | 'followers',
  limit: number
): Promise<IFollow[]> {
  if (!account) return [];
  try {
    const params = new URLSearchParams({ account, type, limit: String(Math.min(limit, 100)) });
    const res = await fetch(`/api/lite/follow/list?${params.toString()}`);
    if (!res.ok) return [];
    const body = (await res.json()) as { entries?: IFollow[] };
    return body.entries ?? [];
  } catch {
    // A follow list is an enhancement to a profile page, never a reason to
    // break it — the chain result (empty) stands.
    return [];
  }
}
