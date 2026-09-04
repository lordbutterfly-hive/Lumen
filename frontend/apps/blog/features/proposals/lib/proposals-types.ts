import type { IProposal } from '@hive/common-hiveio-packages/wax';

/** Segmented tab filter — mirrors the four real proposal lifecycle buckets. */
export type ProposalTab = 'all' | 'active' | 'upcoming' | 'expired';

/** Client-side re-sort of the already-fetched (vote-ranked) proposal window. */
export type ProposalSort = 'votes' | 'newest' | 'daily_pay' | 'ending_soon';

/** Aggregate Decentralized Hive Fund stats shown in the stats bar. */
export interface DhfStats {
  /** Sum of daily_pay for proposals actually within today's funded budget window. */
  dailyFundedHbd: number;
  /** daily_pay of the live "HBD Stabilizer" proposal, or null if none is currently active. */
  hbdStabilizerHbd: number | null;
  /** hive.fund treasury HBD balance divided by 100 (the DHF's 1%-per-day spend rule). */
  maxDailyBudgetHbd: number;
  /** hive.fund treasury HBD balance. */
  totalBudgetHbd: number;
}

/** Result of walking the vote-ranked proposal list against the Return Proposal + budget. */
export interface FundingState {
  /** proposal_id set of proposals that are actually being paid today. */
  fundedIds: ReadonlySet<number>;
  dailyFundedHbd: number;
  /** The on-chain #0 "Return Proposal" — the funding cutoff line. Undefined only if it fell outside the fetch window. */
  returnProposal: IProposal | undefined;
}

/** A proposal plus everything the UI needs, pre-computed once per fetch. */
export interface ProposalViewModel {
  proposal: IProposal;
  id: number;
  isFunded: boolean;
  voteValueHp: number;
  daysRemaining: number;
  /** Only meaningful when isFunded — otherwise the proposal isn't accruing payment. */
  paidHbd: number;
  toPayHbd: number;
}
