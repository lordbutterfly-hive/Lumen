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
import { DEFAULT_RC_LIMIT } from '../lib/vsc/op-builders';
import { getCreatorTokensConfig } from '../lib/creator-tokens-data-source';

/**
 * Resource credits needed for one creator-token call, in HBD base units. Read from
 * the op builder rather than restated, so the two can never drift — if the declared
 * rc_limit changes, this threshold moves with it.
 */
export const MAGI_MIN_RC_FOR_A_CALL = DEFAULT_RC_LIMIT;

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
