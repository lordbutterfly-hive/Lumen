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

import type { ContractRules, MarketPhase } from '../types';
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
 * ★ THE ONE EXEMPTION, AND ITS EXACT SHAPE. The rule protects DEPLOYED bytecode.
 * A build that was listed here in anticipation and then superseded BEFORE it
 * ever reached a chain has no node anywhere reporting it, so replacing that
 * entry costs nothing and keeps the list from filling with fiction. That is what
 * happened on 2026-09-12: bafkreidk6c4b24wllm5fbxpnxmshxi2gx5yeqi2v64lasi5dx2lb3rwo3q
 * was the commission/subscription build, listed here the same day under this
 * module's frontend-first order, and superseded hours later when the
 * escrow-stranding and graduation-gate fixes were folded into the SAME deploy
 * (one update, 10 HBD, owner ruling). It was never broadcast to testnet or
 * mainnet. Before you ever replace a line here again: prove the CID was never
 * deployed by asking the chain, exactly as item 2 above says.
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
  'bafkreih4eper5br4vqmgip6f5vykwmhuxtor4j2pqaw2ewdtwuirzf5h7y', // fast twin, test fixture (see above)
  'bafkreigqshjvsnoauwq6eeiisibbpqpesw5ysuiyhp36rjl3i7xi4dwqwi' // v2 fee/display update (2026-09-09): TradeFeeBps 1000->500, MaxExitTaxBps 2000->1500, exit-tax launder closed on all four rails, per-cohort `lots|` ledger, SellResult.TaxBps = slice-weighted effective rate
]);

/**
 * ★★★ THE NO-SUBSCRIPTION BYTECODE. Its own rule set, NOT a member of
 * `V2_CODE_CIDS` — it sat there briefly and that was a defect, because the
 * launch wizard's "stop" term branches on the rule set and under v2 it
 * promises "Renewing reopens buying on the same token". The activated
 * bytecode has no `renew` export, no `paid_until` and no lapse, so that
 * sentence would have been false in the terms a creator accepts.
 *
 * THE SPLIT ALSO COVERS THE TIMELOCK WINDOW, which is the real reason it
 * cannot just be a copy edit. The frontend must ship BEFORE the contract (an
 * unlisted CID pins every client to v1 forever), so there is a live interval
 * where this code is deployed and NOT yet active. During it the chain still
 * charges the 10 HBD month and still lapses a market, and the client reads
 * the ACTIVE code CID — so it correctly stays on v2 and keeps telling
 * creators the truth. The copy flips by itself the moment activation lands.
 *
 * FOUR changes in ONE deploy (2026-09-12, OWNER RULING), 160,097 B:
 * (a) the 12% commission is 12% of the TOKENS, credited to the owner account
 *     on delivery — no HBD leg on ask/answer/decline/reclaim at all;
 * (b) the 10 HBD monthly subscription is REMOVED — no Renew, no paid_until,
 *     no lapse; a market is ACTIVE from registration until its creator
 *     retires it;
 * (c) a settlement spanning more than MaxSettlementLots cohorts collapses and
 *     merges them instead of refusing, so an escrow can never strand a holder;
 * (d) graduate() gates on the cohort ledger, not the blended matured balance.
 *
 * Proven by execution, not by reading: the five-step escrow path (order →
 * escrow → decline → answer → deadline+reclaim) runs against THIS bytecode in
 * go-vsc-node's real wasm runtime (modules/wasm/e2e/creator_tokens_escrow_test.go).
 */
export const V3_CODE_CIDS: ReadonlySet<string> = new Set([
  'bafkreighvwezdaaatz6fhmtoboxxdp2hnknmljk6o3qaojim5ekhprfdzu' // v3: commission-in-tokens + subscription REMOVED + escrow-stranding + graduation-gate (2026-09-12)
]);
/** The Stage D fixture's CID on its own, so a test can tell the two apart. Same rules as v2; never mainnet. */
/**
 * ★ v4 (2026-09-16, OWNER RULING): v3 plus the removal of the trading-history
 * gate on paid asks. core/settlement.go SettlementRate = min(spot, short TWAP)
 * when the ~hour window prices, spot otherwise; the 7-day window is recorded
 * history only. Build: creator-tokens/build-wasm.sh EXPECTED_CID, reproduced
 * twice at 159,488 bytes. Ships everything v3 was built to ship (the v3 CID
 * was never deployed).
 */
export const V4_CODE_CIDS: ReadonlySet<string> = new Set([
  'bafkreihvrfag55ceybqc4steidpk6iw7tdtpp5rbdm3hongr77nxjxcsbm' // v4: settlement prices off the curve at once; no 2-day / 8-trade gate (2026-09-16)
]);
/**
 * ★ v5 (2026-09-18, OWNER RULING): v4 plus the two settlement SIZE guards
 * opened up — `core/params.go` MaxServiceFaceAreaBps 5000 -> 10000 (a service
 * may cost up to the market's whole curve backing, not half of it) and
 * MaxSpendSupplyBps 500 -> 10000 (a settlement may consume up to the supply
 * itself, not 5% of it). Nothing was deleted: the guard order, the C4
 * minimum-price floor and the C5 divergence tripwire are byte-identical, and
 * both refusals still fire past the new bounds.
 *
 * WHY THE CLIENT MUST KNOW: `settleSpendStatus` mirrors those two constants to
 * refuse before a signature. Mirroring the NEW numbers against an OLD chain is
 * the one direction this module forbids (header, rule 4) — it would offer an
 * ask the chain then refuses at settlement. So the bounds are read from the
 * rule set, never from a bare constant, and v1-v4 keep the old pair.
 *
 * Build: creator-tokens/build-wasm.sh EXPECTED_CID, 159,511 bytes.
 */
export const V5_CODE_CIDS: ReadonlySet<string> = new Set([
  // v5.1, the one that ships: the two opened bounds PLUS the one-credit floor
  // under the missed-ask deterrent (ask.go; an adversarial review found a
  // commission of floor(credits x 12%) rounds to zero at <= 8 credits, so a
  // junk ask that shuts a creator's inflows for a week cost nothing).
  'bafkreicij3ipcglu6xkc25upwlox5okpcfojf6u2g3flfzt2kszw44bdeu',
  // v5.0 — built, deployed to TESTNET only, never to mainnet. Listed so a
  // client reading that testnet contract still derives v5 rules rather than
  // silently falling back to v1 (the CID list is the only thing that can tell
  // them apart, and an unlisted CID means v1 forever).
  'bafkreidmizk2flxzgksyt74ly7iix5ew4b5msuclbdzawhk57jau6e7erq'
]);
/**
 * v6 (2026-09-22, owner ruling: "you cannot price anything in USD if tokens are
 * not made into fractions"). A token divides into TokenScale = 100 units
 * (0.01). State holds UNITS (balances, lots, supply, cap, escrow credits); the
 * wire speaks DECIMAL TOKEN STRINGS ("1.50"); events are v: 2. The curve is
 * unchanged per whole token. A v5.1 key is scaled x100 the first time the
 * contract touches it and flagged (`u6|c|h`, `m|c|u6`), so a reader MUST look
 * at the flag beside every token key: an unflagged "2" is still 2.00 tokens, a
 * flagged "200" is 2.00 tokens (reads.ts tokenCountFromState).
 *
 * Under every earlier rule set this client keeps sending whole tokens and
 * refuses fractional input, because the live bytecode would refuse it.
 * Built 2026-09-22, 167,749 B, two reproducible builds; on testnet since 2026-09-22,
 * mainnet pending the owner's signature. The morning candidate (bafkreih5siwq…,
 * 167,142 B) ran on testnet for a few hours and is deliberately NOT listed: it
 * scaled `bal|` to units, which this client no longer reads that way.
 */
export const V6_CODE_CIDS: ReadonlySet<string> = new Set([
  'bafkreia2lumlku2qvq6hgqztvl64wxhzxpcyurgsapayaj54cdrn7gw7i4' // v6: 0.01-token units, decimal wire, lazy x100 migration, whole-token marketplace door (bal| whole + balf| remainder)
]);
export const V2_FAST_TWIN_CODE_CID = 'bafkreih4eper5br4vqmgip6f5vykwmhuxtor4j2pqaw2ewdtwuirzf5h7y';

/** How long a chain answer about the deployed code is trusted before it is asked again. Bounds the deploy gap (header, item 3). */
export const RULES_TTL_MS = 60_000;
/** How long a FAILED code read is remembered as v1 before retrying. Short, so a blip cannot pin v1 for a whole TTL. */
export const RULES_RETRY_MS = 15_000;

/**
 * The chain's answer to "which bytecode is deployed", mapped to a rule set.
 * Anything unlisted is v1 (header). v3 is tested FIRST because it is the
 * narrower set; the two sets are disjoint, so the order is defensive rather
 * than load-bearing, and it stays correct if a CID is ever listed twice.
 */
export function rulesForCode(code: string | null | undefined): ContractRules {
  if (typeof code !== 'string') return 'v1';
  if (V6_CODE_CIDS.has(code)) return 'v6';
  if (V5_CODE_CIDS.has(code)) return 'v5';
  if (V4_CODE_CIDS.has(code)) return 'v4';
  if (V3_CODE_CIDS.has(code)) return 'v3';
  return V2_CODE_CIDS.has(code) ? 'v2' : 'v1';
}

/**
 * The billing fact v3 introduced (no 10 HBD month) and v4 keeps. Every UI
 * branch that used to read `rules === 'v3'` reads this instead, so a future
 * rule set cannot silently fall back to the subscription copy — the exact
 * `=== 'v2'` shape types.ts warns about, one version later.
 */
export function hasNoSubscriptionUnder(rules: ContractRules): boolean {
  return rules === 'v3' || rules === 'v4' || rules === 'v5' || rules === 'v6';
}

/**
 * v6: token amounts may carry two decimals (0.01 steps) and go on the wire as
 * decimal strings. Under every earlier rule set a token is indivisible and the
 * client must not offer, quote or sign a fraction the chain would refuse.
 */
export function fractionalTokensUnder(rules: ContractRules): boolean {
  return rules === 'v6';
}

/** The smallest token amount a buy, sell, send or ask may move under `rules`. */
export function tokenStepUnder(rules: ContractRules): number {
  return fractionalTokensUnder(rules) ? 0.01 : 1;
}

/**
 * How a paid ask is priced by the live bytecode. 'curve': spot, capped by the
 * ~hour average when one exists, never a required window (v4). 'windowed':
 * the pre-2026-09-16 two-window gate the older bytecodes still enforce, which
 * the quote must keep mirroring or it promises asks the chain refuses.
 */
export function askPricingUnder(rules: ContractRules): 'curve' | 'windowed' {
  return rules === 'v4' || rules === 'v5' || rules === 'v6' ? 'curve' : 'windowed';
}

/**
 * The two settlement size bounds the live bytecode enforces, in basis points —
 * `core/params.go` MaxServiceFaceAreaBps (the depth ceiling, against area(S))
 * and MaxSpendSupplyBps (the spend cap, against supply).
 *
 * v5 opened both; everything older keeps 50% / 5%. Read through this function
 * rather than importing the constants, so a client on an old chain never
 * quotes an ask that chain would refuse (header, rule 4).
 */
export interface SpendGuardBps {
  faceAreaBps: number;
  spendSupplyBps: number;
}

export function spendGuardsUnder(rules: ContractRules): SpendGuardBps {
  return rules === 'v5' || rules === 'v6'
    ? { faceAreaBps: 10_000, spendSupplyBps: 10_000 }
    : { faceAreaBps: 5_000, spendSupplyBps: 500 };
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

// THERE IS NO renewGateUnder. It answered "would the chain accept a renewal on
// this market, and if not, why" — the retire guard, the global pause, then v1's
// terminal-FROZEN refusal or v2's revival check (a FROZEN market carrying a
// pro-rata surplus cannot be revived, because a fresh buyer would take that
// surplus from the holders still in). The 10 HBD monthly subscription was
// removed from the contract on 2026-09-12 (OWNER RULING;
// creator-tokens/core/params.go), so there is no renewal to gate.
//
// ★ reserveVersusCurve ABOVE IS KEPT AND IS STILL USED — it is the surplus /
// deficit comparison itself, which the wind-down surfaces read. Only the
// renewal question that consumed it is gone.

/** core/refund.go CloseIfDrained's phase gate under each rule set (the supply === 0 term included). */
export function closesIfDrainedUnder(rules: ContractRules, m: { phase: MarketPhase; retiredAtBlock: number | null; supplyTokens: number }): boolean {
  if (m.phase === 'CLOSED') return true;
  if (m.phase !== 'FROZEN' || m.supplyTokens !== 0) return false;
  return rules === 'v1' || m.retiredAtBlock !== null;
}
