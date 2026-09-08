'use client';

// ★★★ TX-01 (2026-09-08, REVISED 2026-09-08 after scrutiny): SHOW THE USER THE
// EXACT VESTS A VESTING OP WILL SIGN, IN A UNIT A HUMAN CAN ACTUALLY JUDGE.
//
// withdraw_vesting / delegate_vesting_shares sign a VESTS amount derived from the
// (untrusted) get_dynamic_global_properties ratio. This hook computes that figure
// through transactionService.hpToVestsCheckedWithRatio — the SAME ratio-checked
// derivation the broadcast uses — so the number the dialog renders equals the
// number that will be signed, and a corrupt ratio outside [MIN_VESTS_PER_HIVE,
// MAX_VESTS_PER_HIVE] surfaces HERE as an error (the op is refused) instead of a
// silent, invisible over-delegation.
//
// REVISION: the first cut showed only the raw VESTS figure, which a human typing
// "10 HP" has no intuition for and cannot use to catch a WITHIN-band lie (the
// scrutiny finding: the original [1e3,1e8] band left ~52x of in-band headroom
// over what was then assumed to be the live ratio, and even after tightening the
// band a "few x" lie still passes it by design). Two additions close that gap:
//   1. `hp` echoes back the exact amount the user typed — never re-derived
//      through the untrusted ratio, so it can never be poisoned by it.
//   2. `ratio` is the VESTS/HIVE rate THIS conversion actually applied
//      (signed VESTS / typed HP), and `ratioLooksOff` flags it against
//      REFERENCE_VESTS_PER_HIVE — a small, independent, human-facing anchor —
//      so a node lying 2-3x within the hard band still renders a rate a person
//      can visibly recognise as wrong, instead of an opaque VESTS blob.

import { useQuery } from '@tanstack/react-query';
import { transactionService, ratioLooksOff as ratioLooksOffAgainstReference } from '@transaction/index';
import { getAsset } from '@transaction/lib/utils';

export interface SignedVestsPreview {
  /** The HP amount the user typed, echoed verbatim (never derived from the ratio). */
  hp: string | null;
  /** VESTS in display units (e.g. "18,333,333.000000"), or null when not yet known. */
  vests: string | null;
  /** The VESTS/HIVE rate this specific conversion applied, or null when not yet known. */
  ratio: number | null;
  /** True when `ratio` is far enough from the known-good reference to warrant a second look. */
  ratioLooksOff: boolean;
  /** The refusal message when the ratio is implausible / malformed, else null. */
  error: string | null;
  isLoading: boolean;
}

/** Base-unit VESTS string (precision 6) -> a grouped display string. */
export function formatVests(baseUnits: string): string {
  const n = Number(baseUnits) / 1_000_000;
  if (!Number.isFinite(n)) return '';
  return n.toLocaleString('en-US', { minimumFractionDigits: 6, maximumFractionDigits: 6 });
}

/** VESTS/HIVE rate -> a grouped, whole-number display string (e.g. "1,611"). */
export function formatRatio(ratio: number): string {
  return Number.isFinite(ratio) ? ratio.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '';
}

export function useSignedVestsPreview(amountHp: number): SignedVestsPreview {
  const valid = Number.isFinite(amountHp) && amountHp > 0;
  const q = useQuery({
    // Keyed on the HP amount so the preview updates as the user types, but the
    // global-properties read is cached (staleTime) so it is not a request per key.
    queryKey: ['signedVestsPreview', valid ? amountHp.toFixed(3) : 'none'],
    enabled: valid,
    staleTime: 30_000,
    retry: 1,
    queryFn: async () => {
      const hp = await getAsset(amountHp.toString(), 'HIVE');
      const { vests, ratio } = await transactionService.hpToVestsCheckedWithRatio(hp);
      return { vestsBaseUnits: vests.amount, ratio }; // raw VESTS base units (precision 6) + applied rate
    }
  });
  return {
    hp: valid ? amountHp.toFixed(3) : null,
    vests: q.data ? formatVests(q.data.vestsBaseUnits) : null,
    ratio: q.data ? q.data.ratio : null,
    ratioLooksOff: q.data ? ratioLooksOffAgainstReference(q.data.ratio) : false,
    error: q.isError ? (q.error instanceof Error ? q.error.message : 'Could not work out the VESTS for this amount.') : null,
    isLoading: valid && q.isLoading
  };
}
