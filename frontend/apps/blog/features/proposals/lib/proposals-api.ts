import { IProposal, IProposalVote } from '@hive/common-hiveio-packages/wax';
import { NaiAsset } from '@hiveio/wax';
import { getChain } from '@transaction/lib/chain';
import { getAccount, getDynamicGlobalProperties } from '@transaction/lib/hive-api';
import { computeHivePerMVests, proposalId, TREASURY_ACCOUNT } from './proposals-format';

/**
 * Real proposal window for the page. Sorted by total_votes descending (the same
 * order the Hive protocol itself ranks proposals in for funding), status 'all' so
 * every tab (All/Active/Upcoming/Expired) can be derived client-side from one fetch.
 * 100 is generous: mainnet currently has well under 400 proposals total, and any
 * proposal actually relevant to a stats bar or a funding decision ranks near the top.
 */
const PROPOSAL_FETCH_LIMIT = 100;

export const getProposalsList = async (limit: number = PROPOSAL_FETCH_LIMIT): Promise<IProposal[]> => {
  const chain = await getChain();
  const { proposals } = await chain.api.database_api.list_proposals({
    start: [-1],
    limit,
    order: 'by_total_votes',
    order_direction: 'descending',
    status: 'all'
  });
  return proposals;
};

/** hive.fund treasury HBD balance — source of "Max daily budget" and "Total budget". */
export const getTreasuryHbdBalance = async (): Promise<NaiAsset> => {
  const treasury = await getAccount(TREASURY_ACCOUNT);
  return treasury.hbd_balance;
};

export const getHivePerMVestsLive = async (): Promise<number> => {
  const dgpo = await getDynamicGlobalProperties();
  return computeHivePerMVests(dgpo);
};

/**
 * The set of proposal ids a given account currently has an open vote on.
 * Paginates list_proposal_votes (by_voter_proposal) until results stop belonging
 * to `voter` — the standard "seek" pattern used elsewhere in this codebase
 * (see getActiveVotes in @transaction/lib/hive-api.ts).
 */
export const getUserProposalVoteIds = async (voter: string): Promise<Set<number>> => {
  if (!voter) return new Set();
  const chain = await getChain();
  const BATCH_SIZE = 100;
  const ids = new Set<number>();
  let start: (string | number)[] = [voter, 0];

  while (true) {
    const response: { proposal_votes: IProposalVote[] } = await chain.api.database_api.list_proposal_votes({
      start,
      limit: BATCH_SIZE,
      order: 'by_voter_proposal',
      order_direction: 'ascending',
      status: 'all'
    });
    const proposalVotes = response.proposal_votes;

    const forVoter = proposalVotes.filter((v) => v.voter === voter);
    forVoter.forEach((v) => ids.add(proposalId(v.proposal)));

    if (proposalVotes.length < BATCH_SIZE) break;
    const last = proposalVotes[proposalVotes.length - 1];
    if (last.voter !== voter) break; // ran past this voter's votes into the next account
    start = [voter, proposalId(last.proposal) + 1];
  }

  return ids;
};
