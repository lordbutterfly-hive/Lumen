/**
 * A creator-token read that has not succeeded is UNKNOWN — not zero, not empty.
 *
 * ★★★ THE DEFECT THIS EXISTS TO MAKE UNEXPRESSIBLE (2026-08-10). The studio's
 * secondary reads were spread as `feeQuery.data ?? 0` and `offeringsQuery.data ??
 * []`, and both gate their loading state on the MARKET query rather than on their
 * own — so once the market resolved, a REJECTED fee read rendered as a confident
 * `$0` with the Claim button reading "Claimed" and disabled, and a rejected shop
 * read rendered as "You haven\u2019t posted any services yet". A creator with real
 * unclaimed earnings and a live shop was told, as fact, that they had neither.
 *
 * `??` cannot express the difference between "the node said zero" and "the node
 * did not answer", so it is not used for these. `null` carries the ignorance to
 * the screen, where `commissionEarnedUsd` has always shown the honest answer: an
 * em dash, not a number.
 *
 * Deliberately dependency-free so the rule can be tested without React, a query
 * client or a chain node — see ./__tests__/failed-reads.test.ts.
 */
export function collapseRead<T>(query: { isError: boolean; data: T | undefined }): T | null {
  // `isError` and not `!data`, so a read still in flight is not reported as
  // failed \u2014 and a genuine 0 or [] is not reported as unknown.
  if (query.isError || query.data === undefined) return null;
  return query.data;
}
