// Minimal typed VSC GraphQL client — plain fetch, no new deps. Only the two
// read queries the data source needs, both grounded in the real schema at
// go-vsc-node/modules/gql/schema.graphql:
//
//   getStateByKeys(contractId: String!, keys: [String!]!, encoding: String): Map
//     — "Retrieve contract state values by their keys. Returns a map of
//        key-value pairs from the contract's state merkle tree." (schema.graphql:813)
//        Default (no encoding) returns UTF-8 string values; 1..100 keys per call.
//
//   localNodeInfo: LocalNodeInfo  (schema.graphql:903)
//     type LocalNodeInfo { ... last_processed_block: Uint64! ... }  (schema.graphql:249)
//       — "Most recent Hive L1 block processed by this node." The contract's
//        lock/settle heights are set (by the scheduler) against the same Hive L1
//        block.height the runtime injects, so this is the correct clock to
//        derive open→locked and the lock countdown from.

// A single controlled unknown→object narrow, reused everywhere so the rest of
// the module stays assertion-free.
export function getJsonProp(value: unknown, key: string): unknown {
  if (typeof value === 'object' && value !== null && key in value) {
    return (value as Record<string, unknown>)[key];
  }
  return undefined;
}

function collectGqlErrors(value: unknown): string | null {
  const errors = getJsonProp(value, 'errors');
  if (!Array.isArray(errors) || errors.length === 0) return null;
  return errors
    .map((e) => {
      const message = getJsonProp(e, 'message');
      return typeof message === 'string' ? message : 'unknown error';
    })
    .join('; ');
}

async function postGql(gqlUrl: string, query: string, variables: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(gqlUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  if (!res.ok) {
    throw new Error(`VSC GQL HTTP ${res.status}`);
  }
  const json: unknown = await res.json();
  const errorMsg = collectGqlErrors(json);
  if (errorMsg) {
    throw new Error(`VSC GQL error: ${errorMsg}`);
  }
  return getJsonProp(json, 'data');
}

const STATE_QUERY = `query VscMarketState($contractId: String!, $keys: [String!]!) {
  getStateByKeys(contractId: $contractId, keys: $keys)
}`;

const HEAD_QUERY = `query VscMarketHead {
  localNodeInfo {
    last_processed_block
  }
}`;

export interface VscGqlClient {
  /**
   * Reads the given state keys for a contract. Returns a map covering EXACTLY
   * the requested keys; a key absent from the merkle tree comes back as null
   * (mirroring the contract's own getStr/getU64/getMoney treating "" as zero).
   */
  getStateByKeys(contractId: string, keys: string[]): Promise<Record<string, string | null>>;
  /** Current Hive L1 head height the node has processed, or null if unavailable. */
  getHeadBlock(): Promise<number | null>;
}

export class DefaultVscGqlClient implements VscGqlClient {
  private readonly gqlUrl: string;

  constructor(gqlUrl: string) {
    this.gqlUrl = gqlUrl;
  }

  async getStateByKeys(contractId: string, keys: string[]): Promise<Record<string, string | null>> {
    const out: Record<string, string | null> = {};
    if (keys.length === 0) return out;
    const data = await postGql(this.gqlUrl, STATE_QUERY, { contractId, keys });
    const rawMap = getJsonProp(data, 'getStateByKeys');
    for (const key of keys) {
      const value = getJsonProp(rawMap, key);
      out[key] = typeof value === 'string' ? value : null;
    }
    return out;
  }

  async getHeadBlock(): Promise<number | null> {
    try {
      const data = await postGql(this.gqlUrl, HEAD_QUERY, {});
      const info = getJsonProp(data, 'localNodeInfo');
      const raw = getJsonProp(info, 'last_processed_block');
      const height = Number(raw);
      // A head that coerces to 0 (missing field, empty string, null, or a node
      // still syncing at last_processed_block 0) is finite but is NOT a real
      // block height. Accepting it corrupts every phase/countdown/deadline
      // derived from the head. Every caller already treats null as "unavailable,
      // don't guess", so fail closed here. Mirrors creator-tokens' getHeadBlock.
      return Number.isInteger(height) && height > 0 ? height : null;
    } catch {
      return null;
    }
  }
}
