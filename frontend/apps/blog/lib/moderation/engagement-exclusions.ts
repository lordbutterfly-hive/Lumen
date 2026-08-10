import { isBannedAuthor } from '@ui/config/lists/banned-authors';
import {
  engagementExcludedList,
  isEngagementExcluded,
  resetEngagementExcludedCache
} from '@ui/config/lists/engagement-excluded';

/**
 * ════ WHOSE ENGAGEMENT COUNTS ════
 *
 * ★★ THE ONE PREDICATE THE RETENTION LADDER ASKS (owner ruling, 2026-08-09):
 * "vote amounts dont matter, theyre all botted... if we're keeping comments then the
 * global blacklist and the engagement exclusion list we made should be taken out of
 * the final numbers."
 *
 * Two separate lists, unioned here and nowhere else:
 *
 *   GLOBAL BLACKLIST  `isBannedAuthor` — env-driven, `packages/ui/config/lists/
 *                     banned-authors.ts`. A ban hides their posts AND kills their
 *                     engagement.
 *   ENGAGEMENT LIST   `isEngagementExcluded` — the curator/bot mirror. Their posts
 *                     still rank; only their engagement is invisible.
 *
 * The recsys already unions exactly these two into `VoteExclusions.ring_members`
 * (`recsys/pipeline.py:1412`), which is the set every ranking signal reads. This is the
 * same union for the retention ladder, so a bot that mints no breadth in the feed also
 * mints no rung on the profile. Before this, the two subsystems disagreed about who
 * counts as a person — the feed had been hardened and the ladder had not, which meant
 * the ONE number the ladder is built on (distinct givers) was the softest number in the
 * product.
 *
 * ★ IT DOES NOT EXCLUDE THE AUTHOR. Self-engagement is removed separately, by
 * `creditedGivers(votes, user)`, because "not me" is a per-request fact and these lists
 * are global. Keeping them separate is why a curator can still earn their own rung.
 */

export { engagementExcludedList, isEngagementExcluded, resetEngagementExcludedCache };

/**
 * True when engagement FROM this account counts toward retention numbers.
 *
 * Undefined/empty counts as excluded: an unnamed voter cannot be credited to anybody,
 * and defaulting the unknown case to "counts" is how a parsing failure turns into an
 * inflated headcount.
 */
export function engagementCounts(name: string | undefined | null): boolean {
  if (!name) return false;
  return !isBannedAuthor(name) && !isEngagementExcluded(name);
}

/**
 * Drop every excluded account from a list of engager names, preserving order.
 *
 * Returns the survivors AND how many were removed, because the count is the only way a
 * caller (or an operator wondering why a rung dropped) can tell "this account has no
 * audience" from "this account's audience is bots". Nothing renders the number today;
 * it is logged.
 */
export function filterEngagers<T>(
  items: T[],
  nameOf: (item: T) => string | undefined | null
): { kept: T[]; removed: number } {
  const kept = items.filter((item) => engagementCounts(nameOf(item)));
  return { kept, removed: items.length - kept.length };
}
