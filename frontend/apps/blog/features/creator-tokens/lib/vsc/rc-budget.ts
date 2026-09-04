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
 * ★ ONLY THESE SEVEN ARE MEASURED (renew added 2026-08-30). Every other write falls to `RC_COST_FALLBACK`.
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
/**
 * ★★ RE-MEASURED 2026-08-30 WITH A WALLET-DID CALLER (clauderfly-57, the node's
 * own WASM dry run, same instrument as the 08-21 table). The 08-21 figures were
 * taken with a 15-character Hive name; a `did:pkh:eip155:1:0x…` caller is 47
 * characters and is concatenated into EVERY state key the call writes, and
 * the node charges by bytes written. Measured on evm4's real market:
 *
 *   createOffering (DID)   3,332-3,345    vs the shipped limit 2,993 (2,394 x 1.25)
 *   buy 1 token, supply 0  3,095          vs 2,253 (1,802 x 1.25)
 *   renew                    812          (fallback was 6,000 x 1.25 = 7,500)
 *
 * The first two were LIVE FAILURES: an out-of-gas run burns the whole granted
 * budget and persists nothing, so every wallet-rail offering creation charged
 * the user and did nothing. Table entries are the DEARER reading per action so
 * the 25% margin clears the DID case; a Hive caller simply over-declares, which
 * only costs balance headroom. `buy` was measured against a ZERO-supply market
 * (the first buy touches keys a later one does not): re-measure against a
 * traded market before trusting it further, and never lower it below this.
 * `renew` at 812 closes studio checklist S5 without a broadcast: the RC hold
 * against the same HBD that pays the bill drops from 7,500 to 1,015, so a
 * creator no longer needs ~17.5 HBD in hand to pay a 10 HBD subscription.
 */
/**
 * ★★★ RE-MEASURED AGAIN 2026-08-30 (clauderfly-43), and THREE ROWS WERE STILL TOO
 * LOW after the DID pass above. Same instrument (`simulateContractCalls`, the
 * node's own WASM dry run against the deployed testnet contract), but taken at the
 * actual worst case rather than a representative one. There are THREE cost terms,
 * not one, and the 08-30 DID pass only found the first:
 *
 *   1. CALLER IDENTITY LENGTH, which the pass above found. But `did:pkh:eip155`
 *      is NOT the longest identity — a Bitcoin one is. `did:pkh:bip122:<32 hex>:
 *      <bech32>` is 90 characters against an EVM DID's 59 and a Hive name's 15,
 *      and four of them already hold tokens on this contract, so it is reachable
 *      today, not hypothetical.
 *   2. FREE-TEXT FIELD LENGTH. `createOffering` cost scales with the TITLE, and
 *      the contract's own bound is MaxOfferTitleLen = 64 (core/params.go:156).
 *      Measured on one BTC identity: a 2-character title costs 3,129 and a
 *      64-character one costs 5,693. The 3,345 entry above was a short title, so
 *      every offering with a title longer than roughly 40 characters still failed
 *      at gas. A user-controlled field that moves the cost must be measured AT ITS
 *      OWN LIMIT, never at a typical value.
 *   3. MARKET FRESHNESS, which the pass above already flagged for `buy` and which
 *      applies to `sell` too: the first trade on a zero-supply market touches keys
 *      a later one does not.
 *
 * Measured, BTC identity (90 chars), max-length titles, zero-supply market where
 * it applies — every number below is a real `rc_used` from the node:
 *
 *   register + firstBuy 20   7,859   <- vs the shipped limit 4,325. FAILED AT GAS.
 *   createOffering (64 ch)   5,693   <- vs 4,181. FAILED AT GAS.
 *   setOfferingPrice         4,383
 *   sell 20, fresh market    3,982   <- vs 3,164. FAILED AT GAS.
 *   setOfferingTitle (63 ch) 3,758
 *   register (no firstBuy)   3,607
 *   buy 20, fresh market     3,412   (3,869 limit held, 13% headroom)
 *   transfer                 1,997   (1,970 entry was stale; the limit still held)
 *   setFace                  1,597
 *   deleteOffering           1,373
 *   renew                      831   (812 held)
 *   setCap                     816
 *   retire                     762
 *   claimTradeFees             136
 *
 * `register + firstBuy` is the wallet LAUNCH path — the wizard's own "Take the
 * first tokens yourself" — so at 4,325 a Bitcoin creator's launch could not
 * complete, and an out-of-gas failure burns the whole granted budget and persists
 * nothing. That is the dearest single call in the contract and it was carrying the
 * third-lowest limit.
 *
 * EVERY ENTRY BELOW IS NOW THE WORST MEASURED CASE, so RC_SAFETY_MARGIN is
 * headroom on the worst case rather than on a typical one. A Hive caller
 * over-declares, which costs only balance headroom (`rc_limit` is a RESERVATION
 * checked at ingest, not a charge — the node bills `rc_used`), while
 * under-declaring loses the entire budget. Those two mistakes are not symmetric,
 * so the table takes the expensive side.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ HOW TO MEASURE A ROW, written out in full so the next person does not have to
 * reconstruct it. You need no key, no signature and no broadcast: the node will
 * run the call for you and tell you what it cost.
 *
 * 1. POST to the contract's GraphQL endpoint (the same URL the client reads
 *    state from):
 *
 *      query Sim($input: SimulateContractCallsInput!) {
 *        simulateContractCalls(input: $input) {
 *          success err err_msg ret rc_used gas_used logs state_diff
 *        }
 *      }
 *
 *    with
 *
 *      input: {
 *        tx_id: "<any 40-char string; it is not looked up>",
 *        required_auths: ["<the caller>"],
 *        required_posting_auths: [],
 *        calls: [{ contract_id, action, payload: "<JSON STRING>", rc_limit, intents }]
 *      }
 *
 *    `payload` is the object our own op-builders produce, JSON-stringified.
 *    `intents` is the same `transfer.allow` array buildOp() attaches; pass `[]`
 *    when the call moves no HBD. `rc_used` in the response is the number this
 *    table wants.
 *
 * 2. CHOOSE THE CALLER DELIBERATELY. Cost scales with the caller's identity
 *    string because it is concatenated into every state key the call writes, so
 *    measure with the LONGEST identity that can reach the call — today a Bitcoin
 *    `did:pkh:bip122:…` at 90 characters, not a Hive name at 15.
 *
 * 3. GIVE `rc_limit` A REALISTIC VALUE, not a huge one. The limit is RESERVED
 *    against the caller's HBD balance alongside whatever the call spends, so an
 *    enormous limit makes the simulation fail with `insufficient balance` and
 *    tells you nothing. If that is the error you get, lower the limit and re-run.
 *
 * 4. FOR A CALL THAT NEEDS A PRECONDITION, put the setup in front of it.
 *    `calls` is a LIST and state carries from each call to the next inside one
 *    simulated transaction, so a `sell` is measured by simulating `[buy, sell]`
 *    and reading the second `rc_used`, and an offering edit by simulating
 *    `[createOffering, setOfferingPrice]`. That is how the wallet-caller `sell`
 *    below was measured with nobody on chain holding a token.
 *
 * 5. A FAILED CALL STILL REPORTS `rc_used`, and it is a LOWER BOUND on the real
 *    cost rather than the cost itself — the work stopped at the refusal. Use it
 *    to prove a limit is too low; never enter it as the row.
 *
 * `scratchpad/quote-oracle-proof.ts` is a worked example of the same discipline
 * pointed at a different question (it runs the app's OWN pricing functions
 * against live chain state rather than reimplementing them).
 */
export const RC_COST_BY_ACTION: Readonly<Record<string, number>> = Object.freeze({
  buy: 3_412,
  sell: 3_982,
  transfer: 1_997,
  register: 7_859,
  createOffering: 5_693,
  setOfferingPrice: 4_383,
  setOfferingTitle: 3_758,
  setFace: 1_597,
  deleteOffering: 1_373,
  renew: 831,
  setCap: 816,
  retire: 762,
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

/**
 * ★★★ THE LAUNCH RC PRE-CHECK (2026-09-04, one-signature launch rework, item C).
 *
 * A one-signature launch is a SINGLE Hive transaction carrying `register` (op 0)
 * plus one `createOffering` per configured service (ops 1..N). Every op executes
 * on ONE shared RC session (`modules/state-processing/state_engine.go:2235`
 * creates the session outside the op loop; `modules/rc-system/rc-system.go`'s
 * `rcSession.rcMap` accumulates consumption across ops), so RC is charged
 * CUMULATIVELY: op k's `CanConsume` sees the RC every earlier op already spent.
 * And because the whole tx is ATOMIC (`state_engine.go:2241-2390`: any op
 * failing does `ledgerSession.Revert(); break`, and `callSession.Commit()` runs
 * only `if ok`), a later op that exhausts RC reverts the ENTIRE launch — register
 * and its first-buy included. So the pre-check MUST cover the SUM, not one action.
 *
 * This is why `checkRcBudget` above (which keys off a SINGLE action's limit)
 * CANNOT be reused for the launch — it would undercount the multi-call sum and
 * wave through a launch that runs out of RC mid-bundle and reverts after the
 * creator has signed and waited.
 *
 * The two conditions are the launch generalisation of `checkRcBudget`'s:
 *   1. `rcNeeded <= availableRc`          — every op's rc_limit reservation, summed
 *   2. `rcNeeded + firstBuy <= balance`   — the reservations and the first-buy
 *                                           HBD come out of the same balance
 * `rcNeeded` uses `rcLimitForAction` (the MEASURED worst case + 25%) per op, so
 * it is the conservative ceiling, never an estimate.
 *
 * ★ UNKNOWN POWER NEVER BLOCKS (like Buy). A read we could not complete
 * (`availableRc` or `balanceBaseUnits` null) resolves `ok`, exactly as the Buy
 * affordability check returns 'unknown' rather than a refusal — a spending read
 * that failed must never gate a launch. Only a KNOWN shortfall blocks.
 */
export function checkLaunchRcBudget(input: {
  /** How many `createOffering` ops the launch will carry (one per configured, priced service). */
  offerCount: number;
  /** `getAccountRC.amount` (already balance + free − frozen), or null when unread. */
  availableRc: number | null;
  /** `getAccountBalance.hbd` base units, or null when unread. */
  balanceBaseUnits: number | null;
  /** HBD the optional creator first-buy spends (register's `intents` leg). 0 when there is no first buy. */
  firstBuyHbdBaseUnits?: number;
}): RcBudget {
  // At least one offering always rides a launch (the flow blocks a launch with
  // zero priced offers), and max(1, …) keeps the sum honest even if a caller
  // passes 0. Whole ops only.
  const offerCount = Math.max(1, Math.floor(input.offerCount));
  const rcNeeded = rcLimitForAction('register') + offerCount * rcLimitForAction('createOffering');
  const firstBuy = Math.max(0, Math.floor(input.firstBuyHbdBaseUnits ?? 0));

  // Unknown never blocks — see the doc above.
  if (input.availableRc === null || input.balanceBaseUnits === null) {
    return { ok: true, rcLimit: rcNeeded, blocker: 'none', addBaseUnits: 0 };
  }

  if (input.availableRc < rcNeeded) {
    return {
      ok: false,
      rcLimit: rcNeeded,
      blocker: 'not-enough-rc',
      addBaseUnits: rcNeeded - input.availableRc
    };
  }
  const needed = rcNeeded + firstBuy;
  if (input.balanceBaseUnits < needed) {
    return {
      ok: false,
      rcLimit: rcNeeded,
      blocker: 'not-enough-balance',
      addBaseUnits: needed - input.balanceBaseUnits
    };
  }
  return { ok: true, rcLimit: rcNeeded, blocker: 'none', addBaseUnits: 0 };
}

/**
 * The launch counterpart of `describeRcBudget`: the same actionable, jargon-free
 * remedy, worded for a launch (which spends on BOTH the transaction credit for
 * every op and, if chosen, the first buy). Null when there is nothing to remedy.
 */
export function describeLaunchRcBudget(budget: RcBudget): string | null {
  if (budget.ok) return null;
  const add = hbd(budget.addBaseUnits);

  if (budget.blocker === 'not-enough-rc') {
    return (
      `You don't have enough transaction credit to launch. ` +
      `A launch sends your registration and each offering together, and credit is backed by your HBD balance. ` +
      `Add at least ${add} HBD to top it up; every 1 HBD you hold gives you 1,000 credits, available straight away, and spent credit refills on its own over about five days.`
    );
  }
  return (
    `Your HBD balance is about ${add} HBD short of launching. ` +
    `A launch briefly sets aside part of your balance as transaction credit for each step, and your first buy is paid from the same balance. ` +
    `Add ${add} HBD and this will go through.`
  );
}
