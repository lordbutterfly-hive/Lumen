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

// ★ SAME-ORIGIN PROXY (2026-08-11, sibling fix to job J5's creator-tokens
// proxy — read that fix's doc in features/creator-tokens/lib/vsc/reads.ts
// first; this mirrors it exactly). This client used to `fetch(gqlUrl, …)`
// straight from the browser at REACT_APP_VSC_MARKET_GQL_URL. The identical
// CORS bug applies here: packages/middleware/lib/csp.ts's connect-src
// permission was never the blocker — the Magi node sends no
// Access-Control-Allow-Origin header, so any browser that actually reached
// this code would be refused at the CORS PREFLIGHT before CSP was ever
// consulted. The var is unset in this environment (getMarketConfig()
// returns null and the app falls back to the Mock data source), so the bug
// is dormant, not yet observed failing here — but it is the same shape as
// the creator-tokens failure and will reproduce the moment this feature is
// provisioned. Every query now goes to this app's OWN same-origin route
// (app/api/prediction-market/gql/route.ts), which re-issues it
// server-to-server (no CORS between two servers) against the real endpoint,
// read there via `process.env.REACT_APP_VSC_MARKET_GQL_URL` directly — the
// route deliberately ignores anything a client might send and only ever
// reads its own server env; accepting a client-supplied upstream URL would
// turn a read-only chain proxy into an open SSRF relay.
//
// The proxy also only forwards the TWO known, fixed query strings below
// (STATE_QUERY / HEAD_QUERY, exported so the route can allowlist against the
// same source of truth) — never arbitrary client-sent GraphQL.
const VSC_MARKET_GQL_PROXY_PATH = '/api/prediction-market/gql';

async function postGql(query: string, variables: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(VSC_MARKET_GQL_PROXY_PATH, {
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

export const STATE_QUERY = `query VscMarketState($contractId: String!, $keys: [String!]!) {
  getStateByKeys(contractId: $contractId, keys: $keys)
}`;

export const HEAD_QUERY = `query VscMarketHead {
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
  // No longer picks the network target (see postGql's own doc above — every
  // call now goes to the same-origin proxy, which reads the real upstream
  // from its own server env). Kept as a constructor parameter only so
  // existing call sites (vsc-market-data-source.ts's
  // `new DefaultVscGqlClient(deps.config.gqlUrl)`) do not need an unrelated
  // signature change. Mirrors CreatorTokensGqlClient's identical choice.
  constructor(private readonly gqlUrl: string) {}

  async getStateByKeys(contractId: string, keys: string[]): Promise<Record<string, string | null>> {
    const out: Record<string, string | null> = {};
    if (keys.length === 0) return out;
    const data = await postGql(STATE_QUERY, { contractId, keys });
    const rawMap = getJsonProp(data, 'getStateByKeys');
    for (const key of keys) {
      const value = getJsonProp(rawMap, key);
      out[key] = typeof value === 'string' ? value : null;
    }
    return out;
  }

  async getHeadBlock(): Promise<number | null> {
    try {
      const data = await postGql(HEAD_QUERY, {});
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
