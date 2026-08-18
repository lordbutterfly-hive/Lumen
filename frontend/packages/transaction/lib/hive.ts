import { AccountAuthorityUpdateOperation } from '@hiveio/wax';
import { Entry, IListWitnessVotes, ITrendingTag, IWitness } from '@hive/common-hiveio-packages/wax';
import { getChain } from './chain';
import { withRetry } from './retry';

export interface IDynamicProps {
  hivePerMVests: number;
  base: number;
  quote: number;
  fundRewardBalance: number;
  fundRecentClaims: number;
  hbdPrintRate: number;
  hbdInterestRate: number;
  headBlock: number;
  totalVestingFund: number;
  totalVestingShares: number;
  virtualSupply: number;
  vestingRewardPercent: number;
}

export const getPost = async (
  username: string,
  permlink: string,
  observer: string = ''
): Promise<Entry | null> => {
  const chain = await getChain();
  return chain.api.bridge.get_post({ author: username, permlink, observer });
};

export const getListWitnessVotes = async (
  username: string,
  limit: number,
  order: string
): Promise<IListWitnessVotes> => {
  // ★ A6 retry rollout (2026-08-18): idempotent read, single caller (`/api/witness-votes`).
  return withRetry(
    async () => (await getChain()).api.database_api.list_witness_votes({ start: [username, ''], limit, order }),
    { label: `list_witness_votes(${username})` }
  );
};

/**
 * Fetches witnesses ordered by vote weight, descending (highest-voted first).
 *
 * @param limit max number of witnesses to return
 */
export const getWitnessesByVote = async (limit: number): Promise<IWitness[]> => {
  // The `by_vote_name` index is keyed on [votes, name]. To page from the
  // top of the vote ranking we start the cursor at the maximum possible
  // int64 vote value and let the node walk downward from there. The wax
  // request type only types the first tuple element as `number`, but a
  // JS number cannot represent an int64 vote count without precision
  // loss, so the max value has to be passed as a string.
  //
  // ★ A6 retry rollout (2026-08-18): idempotent read. Single caller
  // (`/api/witnesses-page`), where it already runs inside a `Promise.all`
  // alongside `getDynamicGlobalProperties` (covered by `withHiveRetry`'s much
  // larger 12s budget) — this smaller retry cannot widen that group's own
  // worst case.
  const response = await withRetry(
    async () =>
      (await getChain()).api.database_api.list_witnesses({
        // @ts-ignore -- first start element must be string (int64 precision); wax types it as number
        start: ['9223372036854775807', ''],
        limit,
        order: 'by_vote_name'
      }),
    { label: 'list_witnesses' }
  );
  return response.witnesses;
};

/**
 * Fetches the current trending tags, ordered by top_posts descending.
 *
 * @param limit max number of tags to return
 */
export const getTrendingTags = async (limit: number): Promise<ITrendingTag[]> => {
  // ★ A6 retry rollout (2026-08-18): idempotent read, single caller
  // (`/api/trending-tags`, already cached for an hour with
  // stale-while-revalidate — this only affects the once-an-hour refetch).
  // condenser_api, NOT database_api — see the note on the declaration.
  return withRetry(async () => (await getChain()).api.condenser_api.get_trending_tags(['', limit]), {
    label: 'get_trending_tags'
  });
};

export const getAuthority = async (username: string): Promise<AccountAuthorityUpdateOperation> => {
  const chain = await getChain();
  const operation = await AccountAuthorityUpdateOperation.createFor(chain, username);

  return operation;
};
export interface TransactionOptions {
  observe?: boolean;
}
export type LevelAuthority = Parameters<
  Awaited<ReturnType<(typeof AccountAuthorityUpdateOperation)['createFor']>>['role']
>[0];

const keyTypes = ['active', 'owner', 'posting', 'memo'] as const;

export const getPrivateKeys = async (
  username: string,
  password: string
): Promise<
  {
    type: (typeof keyTypes)[number];
    privateKey: string;
    correctKey: boolean;
  }[]
> => {
  const chain = await getChain();
  const keys = await Promise.all(
    keyTypes.map(async (keyType) => {
      const key = await chain.getPrivateKeyFromPassword(username, keyType, password);
      const operation = (await AccountAuthorityUpdateOperation.createFor(chain, username)).role(keyType);
      const checkKey =
        operation.level === 'memo'
          ? operation.value === key.associatedPublicKey
          : operation.has(key.associatedPublicKey);
      return { type: keyType, privateKey: key.wifPrivateKey, correctKey: checkKey };
    })
  );
  return keys;
};
