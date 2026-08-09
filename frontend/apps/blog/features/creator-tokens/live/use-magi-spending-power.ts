'use client';

/**
 * What can this account actually spend on Magi, and can it transact at all?
 *
 * Two numbers, one question. HBD is what a token costs; resource credits are what
 * it costs to SEND anything. They are independent for a Hive account and the SAME
 * POT for a wallet identity, which is the fact this hook exists to surface:
 *
 *   RC = HBD balance + 10,000 free (only for `hive:` accounts) − frozen
 *
 * So a freshly connected MetaMask or Bitcoin wallet holding no HBD has no resource
 * credits either and **cannot submit a single transaction**. Offering it a Buy
 * button is offering something that cannot be sent. The buy flow therefore has to
 * know this BEFORE it offers the action, not after the signature.
 *
 * ★ THE THRESHOLD IS A REAL NUMBER, not a guess. The node rejects a transaction
 * whose declared `rc_limit` exceeds available RC, and refuses `rc_limit == 0`
 * outright (transaction-pool.go:214). Our creator-token calls declare
 * `DEFAULT_RC_LIMIT = 1_000`, and RC is denominated in HBD base units at 3
 * decimals — so **1.000 HBD on Magi is the floor for a wallet identity to do
 * anything here at all.**
 *
 * A failed read is NOT a zero balance. `readMagiSpendingPower` throws, and this
 * hook keeps the failure distinguishable so no screen can render "you have nothing"
 * when the truth is "we could not ask".
 */

import { useQuery } from '@tanstack/react-query';
import {
  checkAffordable,
  readMagiSpendingPower,
  type AffordabilityReason,
  type MagiSpendingPower
} from '@/blog/lib/lite/wallet/magi-balance';
import { getCreatorTokensConfig } from '../lib/creator-tokens-data-source';

/**
 * Resource credits needed for one creator-token call, in HBD base units.
 *
 * ★ DECOUPLED FROM `DEFAULT_RC_LIMIT`, 2026-08-09. This used to BE that constant,
 * on the reasoning that the two must never drift. They are not the same quantity:
 *
 *   - `rc_limit` is a CEILING we declare on a call. Over-declaring is safe and
 *     nearly free, and it must clear the most expensive entrypoint.
 *   - this is the MINIMUM BALANCE a reader must hold before the UI will let them
 *     try. Over-stating it turns people away who could in fact transact.
 *
 * While they were one constant, raising the ceiling to 100,000 (because
 * `rc_limit: 1_000` was measured failing on chain with `gas_limit_hit`) silently
 * told every reader they needed 100 HBD to buy anything.
 *
 * ★ THE NUMBER, MEASURED on the live testnet contract 2026-08-09 (real
 * `createOffering` broadcasts, `qa/harness/ct-broadcast.mjs`):
 *   rc_limit  1_000 → gas_limit_hit
 *   rc_limit 10_000 → ok
 * So one call costs somewhere in (1_000, 10_000]. 10_000 is the smallest value
 * proven sufficient.
 *
 * ★ THE FREE BASELINE IS HIVE-ONLY — corrected 2026-08-09 after I overclaimed it.
 * I first measured `max_rcs - hbd == 10_000` on three accounts and wrote "every
 * account checked"; all three were `hive:` accounts. A real EVM identity on the
 * same chain measures `hbd=0, max_rcs=0` — diff ZERO. So:
 *
 *   hive: account, no HBD  → 10_000 RC — roughly one call, then stuck
 *   BTC/EVM identity, no HBD → 0 RC — cannot transact AT ALL, from the start
 *
 * For a wallet user the funding route is therefore not a convenience, it is the
 * only way in, and `cannotTransact` is their opening state rather than an edge
 * case. Narrow this only by measuring again, never by guessing downward.
 *
 * Narrow it only by measuring again, never by guessing downward.
 */
export const MAGI_MIN_RC_FOR_A_CALL = 10_000;

const STALE_MS = 20_000;
const REFETCH_MS = 45_000;

export interface MagiSpendingPowerState {
  /** Null until resolved, or when the read failed — check the flags, never assume 0. */
  power: MagiSpendingPower | null;
  isLoading: boolean;
  /** The read failed. NOT "no money": screens must say "couldn't check", never "you have none". */
  failed: boolean;
  /** No Magi endpoint configured, so this cannot be answered at all. */
  unavailable: boolean;
  /** TRUE when the account has too little RC to send even one call. */
  cannotTransact: boolean;
  /** Ask whether a specific cost is affordable, and why not if it isn't. */
  affordability: (costBaseUnits: number) => AffordabilityReason | 'unknown';
}

export function useMagiSpendingPower(account: string | null): MagiSpendingPowerState {
  const config = getCreatorTokensConfig();
  const gqlUrl = config?.gqlUrl ?? '';
  const enabled = Boolean(account) && gqlUrl !== '';

  const query = useQuery({
    queryKey: ['creatorTokens', 'magiSpendingPower', account],
    queryFn: () => readMagiSpendingPower(gqlUrl, account as string),
    enabled,
    staleTime: STALE_MS,
    refetchInterval: REFETCH_MS,
    // One retry only. A missing balance record throws too, and retrying that
    // repeatedly just delays telling the user to fund the account.
    retry: 1
  });

  const power = query.data ?? null;

  return {
    power,
    isLoading: enabled && query.isLoading,
    failed: query.isError,
    unavailable: !enabled && gqlUrl === '',
    // Below the floor for a single call, not merely at zero: 0.5 HBD is a balance
    // and still cannot send anything, which is the confusing case worth naming.
    cannotTransact: power !== null && power.rc.amount < MAGI_MIN_RC_FOR_A_CALL,
    affordability: (costBaseUnits: number) => {
      if (power === null) return 'unknown';
      if (power.rc.amount < MAGI_MIN_RC_FOR_A_CALL) return 'no_resource_credits';
      return checkAffordable(power, costBaseUnits);
    }
  };
}
