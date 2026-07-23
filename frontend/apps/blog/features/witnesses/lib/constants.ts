/**
 * Chain-level constants for the witness voting page. Values mirror the
 * constraints enforced by Hive consensus (witness_vote / witness_proxy
 * evaluators), not arbitrary UI choices.
 */

/** A Hive account can approve at most 30 witnesses at once. */
export const MAX_WITNESS_VOTES = 30;

/** How many witnesses to pull from `list_witnesses` (covers the full active + runner-up set). */
export const WITNESS_FETCH_LIMIT = 250;

/**
 * The all-1s public key hived reports for a witness that has disabled
 * itself (`witness_update` with a null signing key). Matches the constant
 * already used by the wallet app's witness list.
 */
export const DISABLED_SIGNING_KEY = 'STM1111111111111111111111111111111114T1Anm';

/** A witness that hasn't produced a block in 30 days is treated as stale. */
export const STALE_BLOCK_AGE_SECONDS = 30 * 24 * 60 * 60;

/** Hive produces one block roughly every 3 seconds. */
export const SECONDS_PER_BLOCK = 3;

/** Rank cutoff for the "Top 20" filter (the actively-scheduled block producers). */
export const TOP_WITNESS_RANK = 20;
