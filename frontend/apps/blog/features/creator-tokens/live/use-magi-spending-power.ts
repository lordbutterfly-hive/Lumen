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
import { RC_COST_BY_ACTION, checkRcBudget, describeRcBudget, rcLimitForAction } from '../lib/vsc/rc-budget';
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
// ★ THE FLOOR IS THE CHEAPEST ACTION, NOT `buy` (H7, 2026-08-31). It used to be
// `rcLimitForAction('buy')`, so a creator with enough RC to renew (~1,039) but
// not to buy (~4,265) was told "no resource credits" and could not pay their
// subscription — the same trap as blocking a debtor from paying, closed twice
// elsewhere in this codebase. `cannotTransact` must mean "cannot send ANYTHING",
// so it is the minimum declared cost over every action; each control is then
// gated on its OWN action cost in `affordability`, never on this global floor.
export const MAGI_MIN_RC_FOR_A_CALL = Math.min(...Object.keys(RC_COST_BY_ACTION).map((a) => rcLimitForAction(a)));

/**
 * ★ RE-BASED ON MEASUREMENT, 2026-08-21. The 10,000 above it was the smallest
 * value a real `createOffering` broadcast had been SEEN to survive — a bound
 * found by trial, which can only ever move upward, because a success never
 * argues for a smaller number. It was roughly five times the truth, and since RC
 * is the HBD balance, it told wallet users they needed 10 HBD in hand before the
 * UI would let them try anything.
 *
 * `simulateContractCalls` dry-runs the real WASM and reports actual `rc_used`.
 * Measured against the live contract: a buy costs 1,802 RC, a sell 2,531, a
 * transfer 1,970. `rcLimitForAction` is those figures plus 25% headroom, and it
 * is THE SAME function `buildOp` uses to set the ceiling — so the number we gate
 * on and the number we declare can no longer drift apart, which is how the old
 * pair got five times out of step in the first place.
 */

/**
 * The query key for one account's spending power — EXPORTED because something
 * outside this file has to be able to invalidate it.
 *
 * ★ NOTHING EVER DID, AND THAT WAS THE BUG (found 2026-08-21). After a buy or a
 * sell, `use-live-token-market.ts` invalidated the market and the position and
 * stopped there. This key was written in one place and read in none, so with
 * `staleTime` at 20s the Buy modal re-opened showing the PRE-TRADE balance and a
 * user could reasonably conclude they had not been charged. Keep this exported
 * and keep it the single source of the shape; a locally re-typed array would
 * drift and silently stop matching.
 */
export const magiSpendingPowerKey = (account: string | null) =>
  ['creatorTokens', 'magiSpendingPower', account] as const;

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
  /**
   * Ask whether a specific cost is affordable, and why not if it isn't.
   *
   * `action` names the write this is being asked about, so the check can include
   * the `rc_limit` that call will actually declare — which is reserved from the
   * same HBD the purchase spends, and is therefore part of what has to fit.
   * Defaults to 'buy', the only cost this was ever called with before.
   */
  affordability: (costBaseUnits: number, action?: string) => AffordabilityReason | 'unknown';
  /**
   * H6 (2026-08-31): the ACTIONABLE remedy for a spending refusal — exactly how
   * much HBD to add and that credit refills on its own — rather than the bare
   * category. `describeRcBudget` produced this sentence and nothing rendered it.
   * Null when there is nothing to remedy (affordable, or power unread).
   */
  remedy: (hbdLegBaseUnits: number, action?: string) => string | null;
}

export function useMagiSpendingPower(account: string | null): MagiSpendingPowerState {
  const config = getCreatorTokensConfig();
  const gqlUrl = config?.gqlUrl ?? '';
  const enabled = Boolean(account) && gqlUrl !== '';

  const query = useQuery({
    queryKey: magiSpendingPowerKey(account),
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
    affordability: (costBaseUnits: number, action = 'buy') => {
      if (power === null) return 'unknown';
      // H7 (2026-08-31): gate on THIS action's declared cost, not the global buy
      // floor. The node accepts a call whose rc_limit <= available RC per action,
      // so a renew the chain would take at ~1,039 must not be refused because a
      // buy needs ~4,265. `actionLimit` is also the SAME ceiling `buildOp` will
      // declare, so the reservation is counted against the balance alongside it.
      const actionLimit = rcLimitForAction(action);
      if (power.rc.amount < actionLimit) return 'no_resource_credits';
      return checkAffordable(power, costBaseUnits, actionLimit);
    },
    remedy: (hbdLegBaseUnits: number, action = 'buy') => {
      if (power === null) return null;
      const budget = checkRcBudget({
        action,
        availableRc: power.rc.amount,
        balanceBaseUnits: power.balance.hbdBaseUnits,
        hbdLegBaseUnits
      });
      return describeRcBudget(budget, action);
    }
  };
}
