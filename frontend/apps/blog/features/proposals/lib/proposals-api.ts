import { FullAccount, IProposal, IProposalVote } from '@hive/common-hiveio-packages/wax';
import { NaiAsset } from '@hiveio/wax';
import { getChain } from '@transaction/lib/chain';
import { getAccount, getAccounts, getDynamicGlobalProperties } from '@transaction/lib/hive-api';
import { convertToHP } from '@ui/lib/utils';
import { computeHivePerMVests, proposalId, TREASURY_ACCOUNT } from './proposals-format';

/**
 * Real proposal window for the page. Sorted by total_votes descending (the same
 * order the Hive protocol itself ranks proposals in for funding), status 'all' so
 * every tab (All/Active/Upcoming/Expired) can be derived client-side from one fetch.
 *
 * ★ SEEK-PAGINATED, NOT A FLAT LIMIT (2026-08-28 — proposals page silently
 * truncated). A single `limit: 100` call dropped every low-vote-but-currently-
 * active proposal once the chain's all-time proposal count passed 100:
 * `status: 'all'` ranks by all-time total_votes, so long-EXPIRED proposals that
 * racked up huge legacy vote totals crowd fresh, still-votable ones out of a fixed
 * top-100 window entirely — not off one tab, off every tab, because they were
 * never fetched at all. Measured live: 325 proposals exist all-time; 11 of the 18
 * currently-votable proposals (hivesql, hivebuzz, howo, peakd, magi.network,
 * themarkymark, igormuba, hivewatchers, hivecomunitybank, jack-the-ripper x2)
 * ranked below position 100 by that all-time ordering and never rendered under
 * any tab — the owner-reported cutoff, "worldmappin", was exactly the last
 * votable proposal that still fit inside that window. Old assumption ("100 is
 * generous, mainnet has well under 400 proposals") was already false. Page by
 * the same (total_votes, proposal_id) key the chain sorts on — same seek idiom
 * as getUserProposalVoteIds below — until the chain has nothing left to give, so
 * growth in proposal history can never silently truncate the list again.
 */
const PROPOSAL_FETCH_BATCH_SIZE = 100;

export const getProposalsList = async (): Promise<IProposal[]> => {
  const chain = await getChain();
  const proposals: IProposal[] = [];
  let start: (string | number)[] = [-1];

  while (true) {
    const response = await chain.api.database_api.list_proposals({
      start,
      limit: PROPOSAL_FETCH_BATCH_SIZE,
      order: 'by_total_votes',
      order_direction: 'descending',
      status: 'all'
    });
    const page = response.proposals;

    // The first page starts from the API's "beginning" sentinel ([-1]), nothing
    // to dedupe. Every later page re-requests the previous page's last row as an
    // inclusive seek key (same behavior list_proposal_votes has below), so drop it.
    proposals.push(...(proposals.length === 0 ? page : page.slice(1)));

    if (page.length < PROPOSAL_FETCH_BATCH_SIZE) break;
    const last = page[page.length - 1];
    start = [last.total_votes, proposalId(last)];
  }

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

export interface ProposalVoter {
  voter: string;
  /** The voter's own Hive Power at conversion time — see the caveat below. */
  hp: number;
}

/**
 * database_api.find_accounts hard-caps a single call's `accounts` array — confirmed
 * live 2026-08-28: 1000 names succeeds, 1001 fails with `assert_exception`
 * ("list of accounts to find not filled or too big", DATABASE_API_SINGLE_QUERY_LIMIT).
 * `getAccounts()` (hive-api.ts) does not chunk on its own, and the top proposal
 * measured live that same day (#373, "Hive Keychain Development Proposal 2026")
 * has 1,831 direct voters — comfortably over the cap — so this splits the roster
 * before calling it. 500 rather than the full 1000 to leave headroom under the
 * hard limit; the chunks fetch in parallel since each is an independent read.
 */
const ACCOUNTS_PER_BATCH = 500;

async function getAccountsChunked(usernames: string[]): Promise<FullAccount[]> {
  const chunks: string[][] = [];
  for (let i = 0; i < usernames.length; i += ACCOUNTS_PER_BATCH) {
    chunks.push(usernames.slice(i, i + ACCOUNTS_PER_BATCH));
  }
  const results = await Promise.all(chunks.map((chunk) => getAccounts(chunk)));
  return results.flat();
}

/**
 * Every account with a direct, currently-active vote for one proposal, each
 * converted to Hive Power and sorted descending.
 *
 * ★ SERVER-SIDE ONLY. Calling this from a `'use client'` hook would call
 * `getChain()` in the browser and download `wax.common.wasm` — see
 * `lib/chain-fetch.ts`'s header comment for the class of bug this avoids. The
 * one caller is `app/api/proposal-votes/route.ts`.
 *
 * `list_proposal_votes` carries NO per-voter weight (verified live 2026-08-28:
 * a row is exactly `{id, voter, proposal}`, and `proposal` is the same
 * proposal-wide aggregate object — including the same `total_votes` — on every
 * row for a given proposal). The only source for "how much HP is this voter
 * casting" is the voter's own account, so every voter's account has to be
 * fetched. It also only supports alphabetical-by-voter seek order (`by_proposal_
 * voter`), never vote-weight order, so there is no cheap way to ask for "just
 * the top N by HP" — the full roster has to be read before it can be sorted.
 * Same seek idiom as getProposalsList/getUserProposalVoteIds above: reused, not
 * reinvented.
 *
 * ★ PROXIED STAKE IS NOT FOLDED IN (2026-08-28 — flagged, not guessed at).
 * Per Hive's own `45_update_proposal_votes.md`: "A vote is inactive when
 * {voter} has an active proxy" — an account that has set a proxy does not get
 * its own row here at all; it votes "indirectly" through whichever account it
 * proxies to, once THAT account casts a direct vote. The chain's own
 * `total_votes` tally (what `votesToHp` above converts for the card's headline
 * figure) counts that folded-in weight, so a big proxy's row here — its own
 * `vesting_shares` only — can under-state the true weight behind their vote,
 * and the rows in this list will not sum to the card's total. `FullAccount`
 * does carry `proxied_vsf_votes` (packages/common-hiveio-packages/src/wax/
 * app-types.ts:59, already populated by `getAccounts` above — confirmed live:
 * `condenser_api.get_accounts` returns it, e.g. `themarkymark` currently reads
 * `[0,0,0,0]`, i.e. not proxied to right now) which is what the chain itself
 * uses to compute effective vesting shares for this exact case. Deliberately
 * NOT folded into `hp` below: this codebase has no existing, verified
 * implementation of that multi-level math to reuse (grepped clean), and
 * guessing at Hive's C++ `get_effective_vesting_shares` formula risks a
 * confidently WRONG number, which is worse than an honestly-labelled "this
 * account's own HP" figure. Left for a follow-up once the formula is verified
 * against the chain source rather than assumed.
 */
export const getProposalVoters = async (id: number): Promise<ProposalVoter[]> => {
  const chain = await getChain();
  const VOTES_BATCH_SIZE = 100;
  const voterNames: string[] = [];
  let start: (string | number)[] = [id];

  while (true) {
    const response: { proposal_votes: IProposalVote[] } = await chain.api.database_api.list_proposal_votes({
      start,
      limit: VOTES_BATCH_SIZE,
      order: 'by_proposal_voter',
      order_direction: 'ascending',
      status: 'all'
    });
    const page = response.proposal_votes;

    // First page starts from the API's "beginning of this proposal" sentinel
    // ([id], no voter), nothing to dedupe. Every later page re-requests the
    // previous page's last row as an inclusive seek key — same as
    // getProposalsList above — so drop it.
    const fresh = voterNames.length === 0 ? page : page.slice(1);
    voterNames.push(...fresh.filter((v) => proposalId(v.proposal) === id).map((v) => v.voter));

    if (page.length < VOTES_BATCH_SIZE) break; // chain had nothing left at all
    const last = page[page.length - 1];
    if (proposalId(last.proposal) !== id) break; // ran past this proposal's voters into the next one
    start = [id, last.voter];
  }

  if (voterNames.length === 0) return [];

  const dgpo = await getDynamicGlobalProperties();
  const accounts = await getAccountsChunked(voterNames);
  const byName = new Map(accounts.map((a) => [a.name, a]));

  return voterNames
    .map((name) => byName.get(name))
    // An account that voted but no longer resolves — shouldn't happen on Hive
    // (accounts can't be deleted), but this read is best-effort like the rest
    // of this file, not a guarantee every name comes back.
    .filter((a): a is FullAccount => a !== undefined)
    .map((a) => ({
      voter: a.name,
      hp: convertToHP(a.vesting_shares, chain, dgpo.total_vesting_shares, dgpo.total_vesting_fund_hive).toNumber()
    }))
    .sort((a, b) => b.hp - a.hp);
};
