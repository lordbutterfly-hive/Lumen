/**
 * WHICH CONTRACT RULES ARE LIVE, and everything the client derives from the
 * answer. A5 of the 2026-08-30 studio checklist; the lockstep the PRUNED
 * phase-ladder twin measured (findings/59-P25-seam-family.md, M4 and M6).
 *
 * ★★★ DEPLOY ORDER AND THE MAXIMUM GAP. Read this before touching either
 * deploy, at any hour.
 *
 *   1. FRONTEND FIRST. This build is correct against BOTH contracts because it
 *      does not assume which one is deployed: it asks the chain
 *      (`findContract(byId).code`, reads.ts getContractCode) which bytecode
 *      is live and derives every rule below from that answer. Until the chain
 *      reports a CID listed in V2_CODE_CIDS the app behaves exactly as it did
 *      before this module existed (the v1 column of every function here). So
 *      this build goes out BEFORE the contract update and is watched on the
 *      live site against the v1 contract, where it must change nothing.
 *   2. CONTRACT SECOND. The deployed wasm's CID MUST be in V2_CODE_CIDS. A
 *      rebuilt wasm has a different CID, and then this list is stale: the app
 *      keeps treating the chain as v1 forever. That is the SAFE direction (it
 *      refuses to sign a renew on a delisted market and offers Redeem where
 *      Sell now works, the same over-caution the old client had) but it is the
 *      day-six lie the contract change exists to remove, so the deploy is NOT
 *      DONE until `findContract` returns a listed CID. Check it with the exact
 *      query in reads.ts; do not check it by reading this file.
 *   3. THE GAP. Every client flips by itself within RULES_TTL_MS of the chain
 *      reporting the new code, plus the market read's own refetch interval.
 *      Nobody times anything. Maximum acceptable gap between the contract
 *      deploy and clients on v2 rules: two minutes. Longer means the CID list
 *      is wrong, not that the clients are slow.
 *   4. NEVER THE OTHER WAY ROUND. A client assuming v2 against a v1 chain is
 *      the one direction that costs someone: it tells a holder Sell is open
 *      while the chain has that rail shut, and tells a creator to sign a bill
 *      the chain refuses. This module cannot produce that state: 'v2' is only
 *      ever the chain's own answer, never a flag, never an env var, never a
 *      build setting, never the clock.
 *
 * THE DIRECTION OF EVERY DEFAULT IS v1: a failed read, an unrecognised CID, a
 * malformed answer, an UNKNOWN market. v1 is what shipped and was live-proven;
 * being wrong in that direction is recoverable by the next read.
 *
 * WHAT CHANGES BETWEEN THE TWO RULE SETS (contract patch v2,
 * A1-CONTRACT-PATCH-2026-08-30-v2.diff, core/market.go inWindDown and
 * requireMarketAcceptsRenewal, core/refund.go CloseIfDrained):
 *
 *   wind-down       v1: retired OR FROZEN OR CLOSED
 *                   v2: retired OR CLOSED. A natural FROZEN is an inflow stop:
 *                       Buy and Ask still refuse it (RequireInflowOpen is
 *                       unchanged, so contract-math canInflowOpen is unchanged
 *                       too), Sell stays on the curve, Refund refuses.
 *   renew           v1: requireMarketAcceptsMoney: ACTIVE or OVERDUE only, so
 *                       a lapse past grace is permanent.
 *                   v2: requireMarketAcceptsRenewal: FROZEN admitted, but ONLY
 *                       when reserve == Area(supply) exactly (the H16 revival
 *                       check: a market frozen under v1 with partial pro-rata
 *                       refunds carries a surplus that a revived curve would
 *                       hand to the next buyer). Surplus and deficit are both
 *                       refused, with different reasons.
 *   closeIfDrained  v1: FROZEN with zero supply closes.
 *                   v2: only a RETIRED FROZEN with zero supply closes.
 *
 * Pure. No I/O, no clock. The one read that feeds `rules` lives in
 * vsc-data-source.ts (readRules) so this file can be run by a selftest and by
 * the Go twin harness against identical inputs.
 */

import type { ContractRules, MarketPhase, RenewRefusal } from '../types';
import { areaBaseUnitsBig } from '../lib/contract-math';

/**
 * The bytecode deployed on BOTH networks when this module was written, read
 * live 2026-08-31 with the exact query reads.ts sends: testnet
 * vsc1BcaD8JrwJPAAN5cU1cHKCBdZrd7jz2WGt8 and mainnet
 * vsc1BisggC1NtviuYN1mSR372HGSU6hUfdZARt both answered this CID. Recorded so
 * the selftest can assert it maps to 'v1' and so a reader can tell a stale
 * list from a stale chain.
 */
export const V1_CODE_CID = 'bafkreic2nphgjnwte32nkwix7bga2hjcwx5hfo6n5xrgllczpt7ldfu4pi';

/**
 * Every wasm build that carries the v2 rules. Same source bytes give the same
 * CID on every network, so one entry normally covers testnet and mainnet.
 * ★ ADD, NEVER REPLACE: a CID that was ever deployed stays listed, or a node
 * that still reports it flips the app back to v1 rules against a v2 chain.
 * ★ THE MAPPING IS ABOUT RULES, NOT ABOUT WHICH BUILD IS BLESSED. A bytecode
 * belongs here iff it carries the v2 rules (inWindDown, Renew's gate,
 * CloseIfDrained as the header describes). That is why the test fixture is
 * listed unconditionally rather than behind NODE_ENV: a production build of
 * this app pointed at the fixture (Stage D of the build map runs a local
 * frontend against it) must read it as v2, or it pins v1 and the delisting
 * flow under test looks broken while it is working. Listing it costs nothing
 * on a real network, where that bytecode is never deployed (Stage D4).
 *
 * Both CIDs below were recomputed by clauderfly-57 from the artifacts on
 * 2026-08-31, not quoted from memory:
 *   v2          149,608 B  the A1 patch v2 (checklist LOG "v2 ACCEPTED and
 *                          TinyGo-built"); the one that goes to testnet and
 *                          mainnet.
 *   fast twin   149,596 B  TEST FIXTURE for Stage D: identical v2 source with
 *                          only SubscriptionPeriod (30 days -> 40 blocks) and
 *                          GraceBlocks (5 days -> 20 blocks) changed (`diff -r`
 *                          shows exactly those two lines). Deployed to
 *                          testnet under its own id, thrown away after. Must
 *                          NEVER be deployed to mainnet.
 * (pristine, 149,077 B, is V1_CODE_CID above.)
 */
export const V2_CODE_CIDS: ReadonlySet<string> = new Set([
  'bafkreiajgng3ozcazro5goha34f2yfs265iylzi6rr5pk6ttent7s5xocu', // v2
  'bafkreih4eper5br4vqmgip6f5vykwmhuxtor4j2pqaw2ewdtwuirzf5h7y' // fast twin, test fixture (see above)
]);
/** The Stage D fixture's CID on its own, so a test can tell the two apart. Same rules as v2; never mainnet. */
export const V2_FAST_TWIN_CODE_CID = 'bafkreih4eper5br4vqmgip6f5vykwmhuxtor4j2pqaw2ewdtwuirzf5h7y';

/** How long a chain answer about the deployed code is trusted before it is asked again. Bounds the deploy gap (header, item 3). */
export const RULES_TTL_MS = 60_000;
/** How long a FAILED code read is remembered as v1 before retrying. Short, so a blip cannot pin v1 for a whole TTL. */
export const RULES_RETRY_MS = 15_000;

/** The chain's answer to "which bytecode is deployed", mapped to a rule set. Anything unlisted is v1 (header). */
export function rulesForCode(code: string | null | undefined): ContractRules {
  return typeof code === 'string' && V2_CODE_CIDS.has(code) ? 'v2' : 'v1';
}

/** core/market.go inWindDown under each rule set. The rail switch: true routes a holder's exit to Refund, false to Sell. */
export function windingDownUnder(rules: ContractRules, m: { phase: MarketPhase; retiredAtBlock: number | null }): boolean {
  if (m.retiredAtBlock !== null) return true;
  if (m.phase === 'CLOSED') return true;
  return rules === 'v1' && m.phase === 'FROZEN';
}

/**
 * reserve vs Area(supply), exactly, in the contract's own integers: -1 below
 * the curve (deficit), 0 equal (the trading invariant), +1 above (a surplus
 * left by flat pro-rata refunds under v1). BigInt end to end because Area is
 * cubic in supply and the product of a fund comparison must never be a float.
 * `reserveBaseUnits` arrives as a number from the chain string (reads.ts
 * toU64): exact up to 2^53 base units, nine trillion HBD, more than exists.
 */
export function reserveVersusCurve(reserveBaseUnits: number, supplyTokens: number): -1 | 0 | 1 {
  const reserve = BigInt(Math.trunc(reserveBaseUnits));
  const area = areaBaseUnitsBig(supplyTokens);
  return reserve < area ? -1 : reserve > area ? 1 : 0;
}

/**
 * core.Renew's gate under each rule set, with the reason it refuses.
 * v1: Renew's own retire guard, then requireMarketAcceptsMoney.
 * v2: Renew's own retire guard, then requireMarketAcceptsRenewal, whose
 * FROZEN branch is the revival check. The reason is what the Studio and the
 * delisting copy branch on (market/lapse.ts is creator-facing and owns the
 * sentences; this only names the fact).
 */
export function renewGateUnder(
  rules: ContractRules,
  m: { phase: MarketPhase; retiredAtBlock: number | null; globalInflowPaused: boolean; supplyTokens: number; reserveBaseUnits: number }
): { canRenew: boolean; renewRefusal: RenewRefusal | null } {
  const refuse = (renewRefusal: RenewRefusal): { canRenew: false; renewRefusal: RenewRefusal } => ({ canRenew: false, renewRefusal });
  if (m.retiredAtBlock !== null) return refuse('retired');
  if (m.globalInflowPaused) return refuse('paused');
  switch (m.phase) {
    case 'ACTIVE':
    case 'OVERDUE':
      return { canRenew: true, renewRefusal: null };
    case 'FROZEN': {
      if (rules === 'v1') return refuse('lapsed-terminal');
      const c = reserveVersusCurve(m.reserveBaseUnits, m.supplyTokens);
      if (c > 0) return refuse('surplus');
      if (c < 0) return refuse('deficit');
      return { canRenew: true, renewRefusal: null };
    }
    case 'CLOSED':
      return refuse('closed');
    default:
      // UNKNOWN: the read failed. Not a refusal the chain made, and not an
      // admission either; callers gate on phase !== 'UNKNOWN' before this.
      return refuse('closed');
  }
}

/** core/refund.go CloseIfDrained's phase gate under each rule set (the supply === 0 term included). */
export function closesIfDrainedUnder(rules: ContractRules, m: { phase: MarketPhase; retiredAtBlock: number | null; supplyTokens: number }): boolean {
  if (m.phase === 'CLOSED') return true;
  if (m.phase !== 'FROZEN' || m.supplyTokens !== 0) return false;
  return rules === 'v1' || m.retiredAtBlock !== null;
}
