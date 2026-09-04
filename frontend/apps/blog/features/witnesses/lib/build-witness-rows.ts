import Big from 'big.js';
import type { GetDynamicGlobalPropertiesResponse } from '@hiveio/wax';
import type { FullAccount, IWitness } from '@hive/common-hiveio-packages/wax';
import { Chain } from '@transaction/lib/chain';
import { DISABLED_SIGNING_KEY, STALE_BLOCK_AGE_SECONDS } from './constants';
import { WitnessRow } from './types';
import { blockAgeSeconds, parsePriceFeedUsd, stripMarkdown } from './witness-format';

export interface BuildWitnessRowsParams {
  witnesses: IWitness[];
  accounts: Map<string, FullAccount>;
  dgp: GetDynamicGlobalPropertiesResponse;
  chain: Chain;
  ownVotes: Set<string>;
}

/**
 * Merges the raw `list_witnesses` response with witness account profiles
 * and derives rank/HP-votes/block-age/price-feed/vote state. Pure function
 * so it can be unit tested and reasoned about without React or network
 * access — all inputs are already-fetched chain data.
 */
export function buildWitnessRows({ witnesses, accounts, dgp, chain, ownVotes }: BuildWitnessRowsParams): WitnessRow[] {
  const headBlock = dgp.head_block_number;

  return witnesses.map((witness, index) => {
    let hpVotes = Big(0);
    try {
      const hpAsset = chain.calculateWitnessVotesHp(
        witness.votes,
        dgp.total_vesting_fund_hive,
        dgp.total_vesting_shares
      );
      hpVotes = Big(hpAsset.amount).div(Big(10).pow(hpAsset.precision));
    } catch {
      // Wax throws on malformed asset input — fall back to 0 rather than crash the table.
      hpVotes = Big(0);
    }

    const age = blockAgeSeconds(headBlock, witness.last_confirmed_block_num);
    const account = accounts.get(witness.owner);
    // ★ RAW MARKDOWN LEAKED INTO THE TABLE (2026-08-17). witness_description/
    // about are free-form Markdown; stripping it here means every consumer
    // of `row.description` (identity cell, search/filter matching) gets
    // plain text once, instead of each caller re-deriving it.
    const rawDescription = account?.profile?.witness_description || account?.profile?.about || '';
    const description = stripMarkdown(rawDescription);

    return {
      ...witness,
      rank: index + 1,
      hpVotes,
      blockAgeSeconds: age,
      priceFeedUsd: parsePriceFeedUsd(witness.hbd_exchange_rate?.base),
      isDisabled: witness.signing_key === DISABLED_SIGNING_KEY,
      isStale: age > STALE_BLOCK_AGE_SECONDS,
      description,
      isVoted: ownVotes.has(witness.owner)
    };
  });
}
