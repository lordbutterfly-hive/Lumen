import dayjs from 'dayjs';
import { IProposal } from '@hive/common-hiveio-packages/wax';
import { NaiAsset, GetDynamicGlobalPropertiesResponse } from '@hiveio/wax';
import { DhfStats, FundingState, ProposalViewModel } from './proposals-types';

/**
 * The on-chain #0 "Return Proposal" (subject: "Return Proposal", receiver: steem.dao).
 * It always exists and its vote total is the real funding cutoff line: any proposal
 * ranked BELOW it in total_votes receives $0/day regardless of "active" status.
 * See https://gitlab.syncad.com/hive/hive/-/blob/develop/doc/devs/operations/45_update_proposal_votes.md
 */
export const RETURN_PROPOSAL_ID = 0;

/** DHF treasury account (post-HF23 "NEW_HIVE_TREASURY_ACCOUNT" in the Hive protocol). */
export const TREASURY_ACCOUNT = 'hive.fund';

/** A proposal's canonical numeric id — `proposal_id` is authoritative, `id` is a fallback. */
export function proposalId(proposal: IProposal): number {
  return proposal.proposal_id ?? proposal.id;
}

/**
 * Chain date strings (start_date/end_date) arrive as naive ISO strings with no
 * timezone marker (e.g. "2026-05-15T00:00:00") but are UTC. Without normalizing,
 * dayjs parses them as browser-local time. Same pattern as dateToFormatted/
 * dateToShow in packages/ui/lib/parse-date.ts.
 */
export function parseChainDate(d: string): dayjs.Dayjs {
  const isTimeZoned = d.indexOf('.') !== -1 || d.indexOf('+') !== -1 || d.endsWith('Z');
  return dayjs(isTimeZoned ? d : `${d}.000Z`);
}

/** NaiAsset (or the daily_pay-shaped equivalent) -> plain number in its own unit. */
export function assetToNumber(asset: { amount: string; precision: number }): number {
  return Number(asset.amount) / 10 ** asset.precision;
}

/**
 * HIVE per 1,000,000 VESTS — the standard conversion factor for turning a proposal's
 * raw governance vote weight (total_votes, in VESTS-derived units) into Hive Power.
 */
export function computeHivePerMVests(dgpo: GetDynamicGlobalPropertiesResponse): number {
  const hive = assetToNumber(dgpo.total_vesting_fund_hive);
  const vests = assetToNumber(dgpo.total_vesting_shares);
  if (vests === 0) return 0;
  return (hive / vests) * 1e6;
}

/**
 * Converts a proposal's raw `total_votes` string into Hive Power.
 * The 1e12 divisor matches the precision the proposal_vote_object accumulates votes at
 * (VESTS precision 1e6 * an additional 1e6 time-decay scaling factor).
 */
export function votesToHp(totalVotes: string, hivePerMVests: number): number {
  return (Number(totalVotes) / 1e12) * hivePerMVests;
}

/**
 * Walks the proposal list (already fetched sorted by total_votes descending) and
 * determines which ones are ACTUALLY being paid today.
 *
 * `status === 'active'` alone is NOT sufficient — mainnet has "active" proposals with
 * self-declared daily_pay in the hundreds-of-trillions of HBD that will never be funded
 * because their vote rank sits far below the Return Proposal. The real cutoff is: rank
 * strictly above the #0 Return Proposal, AND cumulative daily_pay must still fit inside
 * the treasury's max daily budget.
 */
export function computeFundingState(proposals: IProposal[], maxDailyBudgetHbd: number): FundingState {
  const active = proposals
    .filter((p) => p.status === 'active')
    .slice()
    .sort((a, b) => (BigInt(a.total_votes) < BigInt(b.total_votes) ? 1 : -1));

  const fundedIds = new Set<number>();
  let cumulative = 0;

  for (const p of active) {
    const id = proposalId(p);
    if (id === RETURN_PROPOSAL_ID) break; // everything ranked at/below the return line is unfunded
    const dailyPay = assetToNumber(p.daily_pay);
    if (cumulative + dailyPay > maxDailyBudgetHbd) break; // budget exhausted
    cumulative += dailyPay;
    fundedIds.add(id);
  }

  return {
    fundedIds,
    dailyFundedHbd: cumulative,
    returnProposal: proposals.find((p) => proposalId(p) === RETURN_PROPOSAL_ID)
  };
}

/** Finds the live "HBD Stabilizer" proposal (real, recurring DHF proposal that defends the peg). */
export function findHbdStabilizer(proposals: IProposal[]): IProposal | undefined {
  return proposals.find(
    (p) =>
      p.status === 'active' &&
      (p.subject.toLowerCase().includes('stabiliz') || p.receiver === 'hbdstabilizer')
  );
}

export function computeDhfStats(
  proposals: IProposal[],
  treasuryHbdBalance: NaiAsset,
  funding: FundingState
): DhfStats {
  const totalBudgetHbd = assetToNumber(treasuryHbdBalance);
  const stabilizer = findHbdStabilizer(proposals);
  return {
    dailyFundedHbd: funding.dailyFundedHbd,
    hbdStabilizerHbd: stabilizer ? assetToNumber(stabilizer.daily_pay) : null,
    maxDailyBudgetHbd: totalBudgetHbd / 100,
    totalBudgetHbd
  };
}

function clampDays(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Builds the per-card view model: funded flag, HP vote value, paid/to-pay estimates. */
export function buildProposalViewModel(proposal: IProposal, fundedIds: ReadonlySet<number>, hivePerMVests: number): ProposalViewModel {
  const id = proposalId(proposal);
  const isFunded = fundedIds.has(id);
  const start = parseChainDate(proposal.start_date);
  const end = parseChainDate(proposal.end_date);
  const now = dayjs();
  const totalDurationDays = Math.max(end.diff(start, 'day'), 0);
  const elapsedDays = clampDays(now.diff(start, 'day'), 0, totalDurationDays);
  const remainingDays = clampDays(end.diff(now, 'day'), 0, totalDurationDays);
  const dailyPayHbd = assetToNumber(proposal.daily_pay);

  return {
    proposal,
    id,
    isFunded,
    voteValueHp: votesToHp(proposal.total_votes, hivePerMVests),
    daysRemaining: remainingDays,
    // Paid/to-pay are estimates assuming the FULL daily_pay rate for the funded portion
    // of the timeline — the same heuristic every Hive DHF client uses (there's no cheap
    // way to sum real proposal_pay_operation history client-side). Only meaningful when
    // isFunded; callers must not render these for unfunded proposals.
    paidHbd: isFunded ? dailyPayHbd * elapsedDays : 0,
    toPayHbd: isFunded ? dailyPayHbd * remainingDays : 0
  };
}

export function formatHbd(amount: number): string {
  return `${amount.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 })} HBD`;
}

export function formatHp(amount: number): string {
  return `${amount.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} HP`;
}

/**
 * Compact "18.4M HP" style formatting. Originally the return-threshold card
 * only; also used by proposal-support-footer.tsx's vote-value figure as of
 * 2026-08-17 (full precision there is unreadable at mainnet scale — see that
 * file for the `formatHp` title-attribute fallback).
 */
export function formatHpCompact(amount: number): string {
  const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(
    amount
  );
  return `${compact} HP`;
}

export function formatDateRange(startDate: string, endDate: string): string {
  const start = parseChainDate(startDate);
  const end = parseChainDate(endDate);
  const days = Math.max(end.diff(start, 'day'), 0);
  return `${start.format('MMM D, YYYY')} – ${end.format('MMM D, YYYY')} · ${days} days`;
}
