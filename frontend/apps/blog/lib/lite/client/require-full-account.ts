/**
 * Refuse an action that can only be performed by a real Hive account.
 *
 * WHY THIS EXISTS. A Lumen lite account has no Hive account and no keys. Most of
 * the app already knows that: voting on posts, following, commenting and posting
 * all fork on `account_tier === 'lite'` and take a Lumen-local path instead.
 *
 * Governance did not. `features/witnesses` (21 files) and `features/proposals`
 * (23 files) contained ZERO tier checks, so a lite user saw ordinary-looking
 * "vote" buttons that dropped straight into `transactionService` with no signer
 * configured — surfacing a raw TypeError in a red toast.
 *
 * THESE ACTIONS HAVE NO LUMEN-LOCAL EQUIVALENT, and should not get one. A
 * witness vote and a proposal vote are weighted by staked Hive Power and counted
 * by Hive consensus; recording a shadow copy in our database would be a vote
 * that does not exist, which is worse than no button at all. So this refuses
 * rather than forking.
 *
 * It throws instead of returning a flag because every call site is a react-query
 * `mutationFn` whose existing `onError` already routes through `handleError` —
 * throwing puts a written sentence in front of the user through machinery that
 * is already there, and keeps the guard un-bypassable by a stale render.
 *
 * The buttons should ALSO be hidden or disabled where the tier is known at render
 * time; this is the backstop, not the whole fix.
 */
export function refuseIfLite(accountTier: string | undefined, message: string): void {
  if (accountTier === 'lite') {
    throw new Error(message);
  }
}
