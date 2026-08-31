import { BLOCKS_PER_DAY } from '../lib/contract-math';
// `RenewRefusal` is re-exported, never re-declared: it is owned by types.ts
// alongside the field that produces it, and a second hand-maintained copy of one
// union is exactly the drift class this feature spent 2026-08-30 finding.
import type { MarketPhase, RenewRefusal } from '../types';
export type { RenewRefusal };

/**
 * WHERE A MARKET IS IN ITS SUBSCRIPTION, AND WHAT ITS CREATOR SHOULD BE TOLD.
 *
 * ★★ ONE DERIVATION FOR THREE SURFACES (2026-08-30). The warning before expiry,
 * the delisted state after grace and the pay control are the same question asked
 * at three moments, and this codebase's own history says what happens when that
 * question gets three answers: `market-health.ts` exists because five surfaces
 * each decided independently whether a market was buyable and all five got it
 * wrong. This is the same shape one layer along, so it is one function.
 *
 * ★★★ BLOCKS, NEVER `Date.now()`. A browser clock must not decide whether
 * someone's market is dying — a reader whose laptop is a week fast would be told
 * their listing had lapsed when the chain says it is current, and the reverse is
 * worse. Every boundary here is a block comparison against a head read from the
 * chain. `Market.paidUntilAt` and `graceExpiresAt` exist and are deliberately
 * NOT used: they are milliseconds, and comparing them to anything requires a
 * local clock.
 *
 * ★★★ THREE STATES, NOT TWO. `unknown` is a first-class answer and it is what a
 * caller gets when the head could not be read or the phase is `UNKNOWN`. It must
 * render as SILENCE, never as `delisted`. Telling a creator their market has
 * been delisted because one read failed is the silent-zero class at its worst:
 * the reader has no way to tell a broken page from a broken market, and the
 * statement is about their livelihood. See this feature's own repeated history
 * with collapsing a failed read into a confident zero.
 */

/** How much notice a creator gets before the subscription runs out. */
export const LAPSE_WARNING_BLOCKS = 7 * BLOCKS_PER_DAY;

export type LapseState =
  /** The head or the phase could not be read. State NOTHING. */
  | { kind: 'unknown' }
  /** Paid up with more than the warning window left. */
  | { kind: 'healthy' }
  /** ACTIVE, inside the warning window before `paidUntilBlock`. */
  | { kind: 'expiring'; blocksLeft: number; daysLeft: number }
  /** Past `paidUntilBlock`, inside grace — still taking buyers. */
  | { kind: 'grace'; blocksLeft: number; daysLeft: number }
  /** Past grace. Not taking buyers. */
  | { kind: 'delisted' }
  /** Retired or closed. A lapse banner must not speak here; the wind-down owns this page. */
  | { kind: 'winding-down' };

/**
 * Whole days, rounded UP, with a floor of 1 while any blocks remain.
 *
 * Up rather than down because "2 days left" on something with 2.4 days left is
 * the safe direction for a deadline, and floored at 1 so a market with four
 * hours left never reads "0 days left" — which sounds like it has already
 * happened, on a market that is still perfectly live.
 */
function daysFromBlocks(blocks: number): number {
  return Math.max(1, Math.ceil(blocks / BLOCKS_PER_DAY));
}

/**
 * `windingDown` is taken as an input rather than re-derived: it means retired or
 * closed, which is a different story with its own banner, and duplicating that
 * predicate here is how the two would drift.
 */
export function lapseStateOf(input: {
  phase: MarketPhase;
  paidUntilBlock: number;
  graceExpiresAtBlock: number;
  /** From the chain. NULL when it could not be read — never substitute a local clock. */
  headBlock: number | null;
  windingDown: boolean;
}): LapseState {
  const { phase, paidUntilBlock, graceExpiresAtBlock, headBlock, windingDown } = input;

  // Order matters and mirrors the token page: a retired market is winding down
  // whatever its subscription says, so that answer comes first.
  if (windingDown || phase === 'CLOSED') return { kind: 'winding-down' };
  if (phase === 'UNKNOWN') return { kind: 'unknown' };

  // FROZEN is decided by the CHAIN's own phase, not by our arithmetic, so it
  // survives a missing head — the one lapse answer that does.
  if (phase === 'FROZEN') return { kind: 'delisted' };

  if (headBlock === null || !Number.isFinite(headBlock)) return { kind: 'unknown' };

  if (phase === 'OVERDUE') {
    const blocksLeft = graceExpiresAtBlock - headBlock;
    // Past grace by the block maths while the phase still says OVERDUE: trust
    // the phase (the chain computed it from the same head) and say nothing
    // rather than invent a negative countdown.
    if (blocksLeft <= 0) return { kind: 'unknown' };
    return { kind: 'grace', blocksLeft, daysLeft: daysFromBlocks(blocksLeft) };
  }

  const blocksLeft = paidUntilBlock - headBlock;
  if (blocksLeft <= 0) return { kind: 'unknown' };
  if (blocksLeft > LAPSE_WARNING_BLOCKS) return { kind: 'healthy' };
  return { kind: 'expiring', blocksLeft, daysLeft: daysFromBlocks(blocksLeft) };
}

/**
 * The dismissal key for a warning.
 *
 * ★ KEYED ON THE `paidUntilBlock` IT WAS SHOWN AGAINST, which is what makes
 * paying the bill dismiss the banner on its own: `Renew` moves `paidUntilBlock`
 * forward, so the next render asks about a key that was never dismissed. It also
 * means next month's warning fires again for a creator who dismissed this
 * month's, without any expiry logic of our own.
 */
export function lapseDismissKey(creator: string, paidUntilBlock: number): string {
  return `lumen.lapse-warning.${creator}.${paidUntilBlock}`;
}

/**
 * THE CREATOR-FACING SENTENCE, or null when there is nothing to say.
 *
 * ★★★ THE POST-GRACE COPY BRANCHES ON THE REFUSAL REASON, NOT ON A BOOLEAN.
 * "Renew to reactivate" is an instruction, and on a market where the chain will
 * refuse the payment it is a false one printed on the single screen a creator
 * would act from. Each refusal has a different true thing to say and a different
 * road out, and `surplus` in particular has a road that is not renewal at all.
 *
 * ★ SAYS NOTHING ABOUT HOLDERS' MONEY, deliberately and enforced by a check in
 * the selftest. What a lapse does to a holder differs between the deployed
 * contract and the pending one, and a sentence wrong in either direction is the
 * worst thing that could be on this screen. The reader-facing vocabulary is
 * `market-health.ts`, which is not this module.
 *
 * ★ NO SENTENCE PROMISES WHEN ANYTHING CLEARS. `paused` is the temptation —
 * "back shortly" — and nobody here can commit to that on the operator's behalf.
 */
export function lapseNoticeFor(state: LapseState, renewRefusal: RenewRefusal | null): string | null {
  switch (state.kind) {
    case 'expiring':
      return `Your listing runs out in ${state.daysLeft} ${state.daysLeft === 1 ? 'day' : 'days'}. Renew to keep your market taking buyers.`;
    case 'grace':
      return `Your listing has run out. Your market keeps taking buyers for ${state.daysLeft} more ${state.daysLeft === 1 ? 'day' : 'days'}, then it stops.`;
    case 'delisted':
      return delistedNotice(renewRefusal);
    case 'healthy':
    case 'winding-down':
    case 'unknown':
      return null;
  }
}

function delistedNotice(renewRefusal: RenewRefusal | null): string {
  const head = 'Your market is not taking buyers.';
  switch (renewRefusal) {
    case null:
      return `${head} Renew to reactivate it.`;
    case 'paused':
      // An operator-side stop. Nothing the creator can do, and no date anyone
      // here is entitled to give them.
      return `${head} Payments are paused across Lumen right now, so it cannot be reactivated yet.`;
    case 'lapsed-terminal':
      // v1 rules: the chain refuses a renewal on a lapsed market, permanently.
      // Saying "renew" here would be an instruction the contract rejects.
      return `${head} On the current contract a listing this far past its date cannot be reactivated by paying. Retiring it and launching again is the only route.`;
    case 'surplus':
      // The H16 state: the reserve holds more than the curve says it should, so
      // reviving the market would let a fresh buyer take that difference from
      // the people still holding. Refusing is correct and the creator is owed
      // the reason and the road out.
      return `${head} Its reserve no longer matches its supply, so reactivating it would let a new buyer take value from the people already holding. Retiring it and launching again is the safe route.`;
    case 'deficit':
      return `${head} Its reserve no longer matches its supply, so it cannot be reactivated. Retiring it and launching again is the safe route.`;
    // Both of the next two are wind-down states with their own banner, so
    // reaching either from `delisted` would mean `lapseStateOf` and the phase had
    // disagreed. They still get their own words rather than a shared fallback:
    // "retiring" and "already wound down" are different facts with different
    // roads, and a catch-all here is how the two would be conflated on the one
    // screen a creator acts from. A selftest asserts no two refusals share a
    // sentence, which is what caught them merged.
    case 'retired':
      return `${head} It is retiring, so it will not take buyers again.`;
    case 'closed':
      return `${head} It has finished winding down. Launching again starts a fresh market.`;
  }
}

/**
 * Whether a pay control belongs on screen at all.
 *
 * Never on `unknown` — we do not know there is a bill — and never when the chain
 * would refuse the payment, because a control that always fails is the
 * dead-control fault this feature has already been burned by.
 */
export function shouldOfferRenew(state: LapseState, renewRefusal: RenewRefusal | null): boolean {
  if (renewRefusal !== null) return false;
  return state.kind === 'expiring' || state.kind === 'grace' || state.kind === 'delisted';
}

/**
 * MAY A PAY CONTROL BE ON SCREEN RIGHT NOW?
 *
 * ★★★ THIS IS A DIFFERENT QUESTION FROM "WOULD THE CHAIN ACCEPT A RENEWAL"
 * (2026-08-31). `renewRefusal === null` answers the second one and drives the
 * COPY. It does NOT answer the first, because there is a state where the chain
 * would happily accept a payment and offering one is exactly the wrong thing:
 * a renew that Hive accepted and Magi has not recorded yet
 * (CREATOR_TOKENS_RENEW_UNCONFIRMED). The subscription there is in superposition
 * — it may already be paid — and `renew` STACKS from max(paidUntil, block), so a
 * second broadcast does not retry the first, it buys a SECOND MONTH.
 *
 * ★★ THE GUARD MUST BE ON THE PRIMARY CONTROL, NOT ONLY ON THE RECOVERY ONE.
 * This is the third instance of that exact pattern in this feature: the launch
 * claim released on REGISTER_UNCONFIRMED (F1), the Billing renew ungated while
 * the banner renew was gated, and this. Each time a hazard was correctly
 * identified, correctly guarded on one control, and left live on the control
 * beside it. So the answer lives in ONE function that every pay control reads.
 *
 * The way forward while unconfirmed is the READ-ONLY re-read ("Check again"),
 * which clears the flag once the state is actually known — at which point the
 * pay control returns on its own.
 */
export function shouldOfferRenewNow(input: {
  /** NULL when the chain would accept a renewal. Drives the COPY, not this alone. */
  renewRefusal: RenewRefusal | null;
  /** True while a renew was accepted on Hive but not yet recorded on Magi. */
  renewUnconfirmed: boolean;
}): boolean {
  // Order matters: unconfirmed wins even though the chain would accept, which
  // is the whole point of the state.
  if (input.renewUnconfirmed) return false;
  return input.renewRefusal === null;
}

/**
 * THE READER-FACING SENTENCE for a delisted market, for the token page's own
 * banner.
 *
 * ★★ WHY IT LIVES HERE AND NOT IN `market-health.ts`. That module is the
 * one-WORD vocabulary for chips and cards, and it is 59's. The agreed split is
 * that anything longer than a word about a lapse comes from this module, so the
 * two surfaces cannot end up with two different explanations of one state.
 *
 * ★★★ IT SAYS NOTHING ABOUT WHAT A LAPSE DOES TO MONEY ALREADY HELD, and the
 * rule bites HARDER here than on the creator side, because this reader may be
 * holding. Under the deployed rules a lapse eventually opens the flat pro-rata
 * rail; under the pending ones it does not. A sentence about a holder's value
 * would be wrong in one direction or the other with no third option available.
 * What the reader needs is that they cannot buy, why, and what they can still
 * do — not a forecast about their position.
 *
 * ★ IT DOES STATE THE CAPABILITY THAT REMAINS, which is a different thing from
 * a claim about value: this banner only ever renders on a market that is NOT
 * winding down (`health === 'delisted'`, which by market-health.ts's own
 * definition is the v2 natural-FROZEN case), and selling is exactly what stays
 * open there. A holder is not trapped and is entitled to see that.
 *
 * ★ NO PROMISE ABOUT WHEN. "if the creator renews" is a condition, not a date,
 * and nobody here can commit to the creator's behaviour.
 */
export const DELISTED_READER_NOTICE =
  'This market is not taking buyers: the creator’s listing has lapsed. It can start taking them again if they renew it. Selling is unaffected.';
