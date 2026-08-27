/**
 * WHICH DISCOVERY CONTROLS ARE HONEST TO OFFER, given the rows actually in hand.
 *
 * ★★★ WHY THIS IS A MODULE AND NOT THREE LINES INSIDE `creators-view.tsx`
 * (2026-08-27). The view is a `'use client'` component that imports
 * `@hive/ui`, `next/navigation` and the live query hooks, so nothing can import
 * it outside a bundler — which is exactly the constraint
 * `market/curve.selftest.ts`'s header documents for this feature's other pure
 * logic. A rule about what a screen may claim, living only inside that screen,
 * is a rule no test can reach. This is the same split `market/curve.ts` already
 * makes for the money math, applied to a display decision that turned out to
 * matter just as much.
 *
 * THE RULE. `/creators` offers three ordering tabs and an "Answers" filter, and
 * all four read the SAME delivery columns of the Magi indexer's
 * `lumen_ct_discovery` view: completion rate, rating, median response. Those
 * columns are nullable, and on the live testnet build every one of them is null
 * for every creator — 13 rows, `answered_count: 0, missed_count: 0,
 * completion_pct: null`, which is why all 13 cards read "No deliveries yet".
 *
 * With that corpus the controls are not merely inert, they MISLEAD:
 *
 *   - "Most reliable" is the DEFAULT tab, so a first-time reader is told the
 *     order in front of them ranks creators by reliability. It ranks nothing;
 *     what they are reading is the index's tie-break order.
 *   - "Fastest" re-sorts the same nulls, so it is a control that visibly does
 *     nothing when pressed.
 *   - "Answers" filters to `completionPct !== null`, i.e. to ZERO creators —
 *     pressing it empties the grid and prints "No creators match this filter
 *     yet" while live markets sit an inch above it in the New-here shelf.
 *
 * ★ THIS IS NOT THE STALENESS BANNER'S JOB AND DOES NOT REPLACE IT. That banner
 * ("The creator index is about N hours behind the chain") is correct, was built
 * deliberately, and answers a different question: it says the delivery data is
 * OLD. This says there is no delivery data AT ALL. Both are true on the current
 * build — ~30 hours behind AND nothing to rank — and neither implies the other.
 */

import type { CreatorSummary } from '../types';

/** The three orderings `/creators` offers. `reliable` is the indexer's own SQL order, preserved verbatim. */
export type DiscoverySort = 'reliable' | 'fastest' | 'new';

/** What the page may actually offer and apply, once the corpus has had its say. */
export interface DiscoveryControls {
  /**
   * There is at least one delivery record to rank on. FALSE hides the ordering
   * tabs and the Answers filter — every one of them selects on this same
   * signal, so leaving any of them up keeps a control that can only mislead or
   * blank the page.
   */
  rankingAvailable: boolean;
  /** The ordering to actually apply. */
  sort: DiscoverySort;
  /** Whether to actually apply the answered-only filter. */
  answersOnly: boolean;
}

/**
 * Derived from the ROWS, never from a flag or a build switch: the controls come
 * back on their own the first time a creator has a record, with no second place
 * anyone has to remember to switch them on.
 *
 * Only `completionPct` is consulted. It is the column the SQL ranking leads on
 * and the one the card itself branches on to choose between a real record and
 * "No deliveries yet", so a creator this returns true for is exactly a creator
 * whose card shows a rankable record. Reading the counts instead would let a
 * row with `answered_count > 0` but an unreadable percentage re-enable a sort
 * that still has nothing to order by.
 */
export function hasDeliveryCorpus(creators: readonly Pick<CreatorSummary, 'completionPct'>[]): boolean {
  return creators.some((c) => c.completionPct !== null);
}

/**
 * ★ THE DEFAULT MOVES ONLY WHILE THERE IS NOTHING TO RANK, and it moves to an
 * ordering that already exists rather than to a new comparator.
 *
 * This deliberately does NOT disturb the standing rule that the indexer owns
 * the ranking: with a real corpus the default is `reliable`, the branch that
 * leaves `lumen_ct_discovery`'s SQL order untouched. `new` is derived from
 * `registeredBlock` against the live chain head, so while the index has no
 * record to offer it is the one ordering on the page that is both meaningful
 * and current.
 */
export function resolveDiscoveryControls(
  creators: readonly Pick<CreatorSummary, 'completionPct'>[],
  requestedSort: DiscoverySort,
  requestedAnswersOnly: boolean
): DiscoveryControls {
  const rankingAvailable = hasDeliveryCorpus(creators);
  return {
    rankingAvailable,
    sort: rankingAvailable ? requestedSort : 'new',
    answersOnly: rankingAvailable && requestedAnswersOnly
  };
}
