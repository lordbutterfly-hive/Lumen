import { getStorageItem, removeStorageItem, setStorageItem } from '@ui/lib/storage-with-ttl';
import { EXECUTION_CONFIRM_TIMEOUT_MS } from '../lib/vsc-data-source';

/**
 * ★★★ CROSS-TAB DOUBLE-SUBMIT GUARD FOR MONEY-MOVING WRITES (2026-09-01, owner
 * decision: build it before launch; clauderfly-57 adversarial review #2).
 *
 * WHY. Adding execution confirmation (vsc-data-source.ts awaitExecution, up to
 * EXECUTION_CONFIRM_TIMEOUT_MS) widened the window in which a write is "in
 * progress" from ~2s (broadcast-accept) to the full confirm window. Each hook's
 * own `inFlight` ref is per-TAB, so a SECOND TAB is unguarded — and a duplicate
 * here is not free: a second BUY is another purchase further up the curve, a
 * second ASK a second escrow plus a second commission. This is the same hole
 * use-meritum-launch.ts closes for launch, generalised to the money paths.
 *
 * HOW. A claim in localStorage — the thing tabs share — through the repo's TTL
 * wrapper (the app lint rule forbids raw localStorage). KEYED PER (market,
 * signer), NOT per account: two different markets must never block each other
 * (57 review #2), and a second account acting on the same market is a
 * legitimate different actor.
 *
 * TTL DERIVED, never hand-matched: EXECUTION_CONFIRM_TIMEOUT_MS + 30s, so the
 * claim always OUTLIVES the operation. A claim that expires exactly when the op
 * gives up is the F1 shape — a guard that isn't there (see use-meritum-launch's
 * LAUNCH_CLAIM_TTL note, which derives the same way). The TTL also self-heals a
 * tab that crashes mid-write: without it, a crash would lock the user out of
 * their own market until they cleared storage.
 */
export const TX_CLAIM_TTL_MS = EXECUTION_CONFIRM_TIMEOUT_MS + 30_000;

export const txClaimKey = (creator: string, signer: string): string => `meritum:tx-inflight:${creator}:${signer}`;

// ★ REGISTER IS NOT GUARDED HERE. Launch has its own cross-tab claim
// (use-meritum-launch.ts LAUNCH_CLAIM, the F1 fix), deriving its TTL from
// REGISTER_CONFIRM_TIMEOUT_MS the same way this derives from
// EXECUTION_CONFIRM_TIMEOUT_MS. Different keys, no conflict — do not add a second
// overlapping claim for register here (clauderfly-57 review note).

const BUSY_MESSAGE =
  'CREATOR_TOKENS_BUSY: another action for this market is still confirming. Wait for it to finish before trying again.';

/**
 * Run a money-moving write under the cross-tab claim.
 *  - ALREADY CLAIMED (another tab, the common case) -> throw BUSY, run nothing,
 *    and do NOT overwrite the holder's claim.
 *  - SUCCESS, or a *_REFUSED / pre-broadcast validation throw (nothing landed)
 *    -> release; a retry is safe.
 *  - A *_UNCONFIRMED, or the wallet rail's "may already have been accepted" (the
 *    op MAY still land) -> KEEP and extend, so a retry cannot double-charge until
 *    the TTL self-heals. This is use-meritum-launch.ts's REGISTER_UNCONFIRMED
 *    rule, generalised.
 *
 * ★ BEST-EFFORT, NOT A MUTEX (clauderfly-57 review). localStorage has no
 * compare-and-swap, so a plain check-then-set is a TOCTOU: two tabs can both read
 * null. It is narrowed with a unique token — write ours, read it back, proceed
 * only if what we read is ours — so two simultaneous tabs resolve to ONE winner
 * (the last writer) instead of both proceeding. The crash-safe TTL and the
 * per-op wallet signature bound the residual; this is a guard, not a lock.
 *
 * ★ AN UNAVAILABLE STORE MEANS NO LOCK, BY DESIGN. setStorageItem returns false
 * in a private window / on quota exhaustion; then there is nothing to verify or
 * release, and the write proceeds UNGUARDED rather than being blocked — degrading
 * to the old behaviour, never refusing a real transaction.
 */
export async function runUnderTxClaim<T>(creator: string, signer: string, fn: () => Promise<T>): Promise<T> {
  const key = txClaimKey(creator, signer);
  // A claim already held (one op in progress) -> refuse without clobbering it.
  if (getStorageItem<string>(key) !== null) throw new Error(BUSY_MESSAGE);
  // Token read-back narrows the check-then-set race (see doc): two tabs that both
  // saw null both write, and only the one whose token survives the read-back
  // proceeds.
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const wrote = setStorageItem(key, token, TX_CLAIM_TTL_MS);
  // Only a store that actually wrote can be verified or released; if it did not
  // (unavailable), proceed unguarded rather than block a real transaction.
  if (wrote && getStorageItem<string>(key) !== token) throw new Error(BUSY_MESSAGE);
  try {
    const result = await fn();
    if (wrote) removeStorageItem(key);
    return result;
  } catch (err) {
    if (wrote) {
      const msg = err instanceof Error ? err.message : '';
      // "May still land" -> a retry could double-submit. Covers our own
      // *_UNCONFIRMED codes and submit.ts's "may already have been accepted".
      const mayStillLand = msg.includes('_UNCONFIRMED') || msg.includes('may already have been accepted');
      if (mayStillLand) setStorageItem(key, token, TX_CLAIM_TTL_MS);
      else removeStorageItem(key);
    }
    throw err;
  }
}
