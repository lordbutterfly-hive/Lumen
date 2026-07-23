import Big from 'big.js';
import { IWitness } from '@hive/common-hiveio-packages/wax';

/** Which set of columns the table currently renders. */
export type WitnessViewMode = 'general' | 'params';

/**
 * A witness row merged from `list_witnesses` + the witness's account
 * (for avatar/description) + derived, chain-computed values (HP votes,
 * block age, price feed). Every field here traces back to a real API
 * response — nothing on this type is placeholder data.
 */
export interface WitnessRow extends IWitness {
  /** 1-based rank in the vote-sorted list. */
  rank: number;
  /** Vote weight converted to Hive Power via chain.calculateWitnessVotesHp. */
  hpVotes: Big;
  /** Seconds since the witness's last confirmed block, derived from head block. */
  blockAgeSeconds: number;
  /** HBD price feed, in USD, parsed from hbd_exchange_rate. */
  priceFeedUsd: number;
  /** true when signing_key is the all-1s disabled key. */
  isDisabled: boolean;
  /** true when the witness hasn't produced a block within STALE_BLOCK_AGE_SECONDS. */
  isStale: boolean;
  /** Short witness statement, from the witness account's posting_json_metadata.profile.witness_description. */
  description: string;
  /** true when the logged-in user's witness_votes include this witness. */
  isVoted: boolean;
}

export interface WitnessFilterState {
  active: boolean;
  disabledOrStale: boolean;
  top20: boolean;
  approved: boolean;
  search: string;
  version: string;
}

export const DEFAULT_WITNESS_FILTERS: WitnessFilterState = {
  active: false,
  disabledOrStale: false,
  top20: false,
  approved: false,
  search: '',
  version: 'any'
};
