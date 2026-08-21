/**
 * How much resource credit a creator-tokens call really needs, and whether this
 * account can afford to send it.
 *
 * ── WHAT RESOURCE CREDITS ARE (this is not a fee, and it is not a bug) ──
 *
 * On Magi, RC is what pays for a transaction instead of a fee. The node computes
 * it as `balance - frozen` (`modules/rc-system/rc-system.go:27-45`):
 *
 *   available RC = HBD balance (+10,000 for a `hive:` account only) - frozen
 *
 * Spending RC freezes it. The frozen part returns CONTINUOUSLY over
 * RC_RETURN_PERIOD, five days (`modules/common/params/params.go:99`) — it is not
 * locked away and released in one lump at the end. And because the ceiling IS the
 * balance, depositing HBD raises available RC the moment it lands, at
 * 1 HBD = 1000 RC. Running low is the system working, not a failure.
 *
 * ★ THE PART THAT BITES: `rc_limit` IS RESERVED AGAINST THE SAME HBD YOU ARE
 * SPENDING. It is not a separate allowance. Declaring a big ceiling on a buy
 * competes with the purchase itself, and the node answers `insufficient balance`
 * — which reads like "you are broke" when the real cause is "you asked to reserve
 * too much". Measured on the live testnet, buying 1 token as a wallet holding
 * 6.375 HBD (purchase 1.442 HBD):
 *
 *   rc_limit  6,000 -> ledger_error "insufficient balance"   (6,000 + 1,442 > 6,375)
 *   rc_limit  3,000 -> SUCCESS, rc_used 1,802                (3,000 + 1,442 < 6,375)
 *
 * So affordability is TWO conditions, and the balance one is the one that used to
 * be missed. See `checkRcBudget` below.
 *
 * ── WHY THE OLD CONSTANT WAS A DEFECT ──
 *
 * `DEFAULT_RC_LIMIT = 30_000` went on every call. Since the ceiling must be
 * affordable, that silently required every user to hold 30 HBD before they could
 * attempt a purchase costing 1.4 HBD. A wallet holding 3.454 HBD could not make a
 * single call — not because it lacked money for the token, but because of a
 * constant we chose. The node's own floor to ATTEMPT a call is 100 RC
 * (`modules/state-processing/transactions.go:106-112`), not 30,000.
 *
 * Altera is not the model here. It hardcodes 1000 / 2000 / 10000 per action with a
 * literal `// TODO: estimate RC usage` (`vscOperations/swap.ts:144`) and runs no
 * pre-flight check at all — it just forwards the node's rejection after the fact
 * (`sendswap/utils/sendUtils.ts:667`). We can do better, because the node exposes
 * `simulateContractCalls`, which dry-runs the real WASM and reports true
 * `rc_used`/`gas_used`. That is where every number below came from.
 *
 * ── WHY OVER-DECLARING IS NOT FREE ──
 *
 * On an out-of-gas failure the caller is charged essentially the WHOLE granted
 * budget and nothing persists: contract writes roll back
 * (`state_engine.go:2088-2092`) but the RC debit is not reverted (`:2025-2026`,
 * frozen at `:2517-2544`). That is deliberate metering, documented at
 * `params.go:13-15` — not a node bug. It does mean a client that sends a call it
 * could have known would fail is burning the user's RC for nothing, so the
 * pre-flight below refuses rather than sends.
 */

/**
 * Measured RC cost per action, from `simulateContractCalls` against the live
 * testnet contract on 2026-08-21. These are ACTUAL `rc_used` from a dry run of the
 * real WASM, not estimates and not guesses:
 *
 *   buy 1 token       1,802     buy 5 tokens      1,802
 *   sell 1 token      2,529     sell 4 tokens     2,531
 *   transfer 2 tokens 1,910     transfer 1 token  1,970
 *   register          3,460     createOffering    2,394
 *   claimTradeFees      142
 *
 * Cost is essentially flat in quantity — it is the state writes that cost, not the
 * arithmetic — so one number per action is the right shape.
 *
 * `transfer` is entered as 1,970, the dearer of the two readings, and confirmed
 * against a REAL broadcast rather than only a dry run: a live BTC-to-EVM transfer
 * on 2026-08-21 moved the sender from 24,011 available RC to 22,105, i.e. 1,906
 * actually charged against 1,910 simulated. The simulator is trustworthy here.
 *
 * ★ ONLY THESE SIX ARE MEASURED. Every other write falls to `RC_COST_FALLBACK`.
 * Do not invent a row; measure it with `simulateContractCalls` and paste the
 * number, the way these were.
 *
 * Worth knowing when reading a failure: the node charges a FLAT ~100-265 RC when a
 * call is rejected on validation (bad range, unknown id, missing intent) — proven
 * by simulating a dozen deliberately invalid payloads. Only running OUT OF GAS
 * costs the whole budget, because exhausting the budget is definitionally how that
 * failure happens. So the expensive mistake is under-declaring the ceiling, never
 * sending a call the contract will reject outright.
 */
export const RC_COST_BY_ACTION: Readonly<Record<string, number>> = Object.freeze({
  buy: 1_802,
  sell: 2_531,
  transfer: 1_970,
  register: 3_460,
  createOffering: 2_394,
  claimTradeFees: 142
});

/**
 * For an action nobody has measured yet. Set above the most expensive thing we
 * HAVE measured (sell, 2,531) with room to spare, because an under-declared limit
 * fails at gas and burns the whole budget, while an over-declared one only needs
 * to be affordable. It is still an order of magnitude below the old 30,000.
 */
export const RC_COST_FALLBACK = 6_000;

/**
 * Headroom over the measured figure. Contract cost moves a little with state — a
 * market's first buy touches keys a later one does not — and the penalty for
 * guessing low is losing the entire budget to `gas_limit_hit`, while the penalty
 * for guessing high is only needing a slightly larger balance. 25%.
 */
export const RC_SAFETY_MARGIN = 1.25;

/** The node refuses `rc_limit == 0` outright (`transaction-pool.go:214`). */
export const NODE_MIN_RC_LIMIT = 100;

/**
 * The `rc_limit` to declare for one call. Measured cost plus margin, floored at
 * the node's own minimum.
 */
export function rcLimitForAction(action: string): number {
  const measured = RC_COST_BY_ACTION[action] ?? RC_COST_FALLBACK;
  return Math.max(NODE_MIN_RC_LIMIT, Math.ceil(measured * RC_SAFETY_MARGIN));
}

export type RcBlocker = 'none' | 'not-enough-rc' | 'not-enough-balance';

export interface RcBudget {
  /** Safe to sign and send. */
  ok: boolean;
  /** What we will declare as `rc_limit`. */
  rcLimit: number;
  /** Which condition fails, if any. */
  blocker: RcBlocker;
  /** HBD base units the user must add to clear the blocker. 0 when ok. */
  addBaseUnits: number;
}

/**
 * Can this account send this call right now?
 *
 * BOTH conditions must hold, and they are genuinely different:
 *
 *   1. `rcLimit <= availableRc`      — the node's ingest gate
 *                                      (`transaction-pool.go:213-215`)
 *   2. `rcLimit + hbdLeg <= balance` — the reservation and the purchase come out
 *                                      of the same HBD, so they compete
 *
 * Condition 2 is the one that produces `insufficient balance` on a user who can
 * plainly afford the token, and it is invisible unless you check it here.
 *
 * @param availableRc      `getAccountRC.amount` — already `balance + free - frozen`
 *                         (`gqlgen/schema.resolvers.go:447-457`). It is AVAILABLE
 *                         RC, not RC used; reading it as "used" inverts the check.
 * @param balanceBaseUnits `getAccountBalance.hbd`
 * @param hbdLegBaseUnits  HBD this call itself spends (a buy's cost). 0 for a sell
 *                         or a transfer, which move tokens, not HBD.
 */
export function checkRcBudget(input: {
  action: string;
  availableRc: number;
  balanceBaseUnits: number;
  hbdLegBaseUnits?: number;
}): RcBudget {
  const rcLimit = rcLimitForAction(input.action);
  const hbdLeg = Math.max(0, Math.floor(input.hbdLegBaseUnits ?? 0));

  if (input.availableRc < rcLimit) {
    return {
      ok: false,
      rcLimit,
      blocker: 'not-enough-rc',
      addBaseUnits: rcLimit - input.availableRc
    };
  }
  const needed = rcLimit + hbdLeg;
  if (input.balanceBaseUnits < needed) {
    return {
      ok: false,
      rcLimit,
      blocker: 'not-enough-balance',
      addBaseUnits: needed - input.balanceBaseUnits
    };
  }
  return { ok: true, rcLimit, blocker: 'none', addBaseUnits: 0 };
}

/** Base units to a human HBD string, e.g. 1802 -> "1.802". */
function hbd(baseUnits: number): string {
  return (Math.ceil(baseUnits) / 1000).toFixed(3);
}

/**
 * The warning text, in plain words.
 *
 * ★ IT MUST NOT SAY "you are out of credits" AND STOP. Every real user hitting
 * this can fix it in one step, and the fix is not obvious unless we say it: RC is
 * backed by the HBD balance, so depositing HBD raises it immediately. Naming the
 * exact amount is the difference between a dead end and an instruction.
 *
 * Deliberately free of jargon: no "rc_limit", no "base units", no "gas".
 */
export function describeRcBudget(budget: RcBudget, action: string): string | null {
  if (budget.ok) return null;
  const add = hbd(budget.addBaseUnits);

  if (budget.blocker === 'not-enough-rc') {
    return (
      `You don't have enough transaction credit left to ${action}. ` +
      `Credit is backed by your HBD balance, and it refills on its own over about five days after you spend it. ` +
      `You can also top it up right now by adding at least ${add} HBD. Every 1 HBD you hold gives you 1,000 credits, available straight away.`
    );
  }
  return (
    `Your HBD balance is about ${add} HBD short. ` +
    `Sending a transaction briefly sets aside part of your balance as transaction credit, so that amount is not available to spend at the same moment. ` +
    `Add ${add} HBD and this will go through.`
  );
}
