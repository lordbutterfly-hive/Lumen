import env from '@beam-australia/react-env';

// Runtime config for the real (on-chain) prediction-market data source. Read via
// the same @beam-australia/react-env mechanism the rest of the app uses (see
// packages/ui/config/public-vars.ts) — env('X') reads the REACT_APP_X runtime
// var from /__ENV.js on the client and process.env on the server.
//
// Keys (all REACT_APP_-prefixed on the actual env):
//   REACT_APP_VSC_MARKET_CONTRACT_ID  — deployed contract id (vsc1...). REQUIRED.
//   REACT_APP_VSC_MARKET_NET_ID       — VSC network id the call is scoped to. REQUIRED.
//   REACT_APP_VSC_MARKET_GQL_URL      — VSC GraphQL endpoint. REQUIRED.
//   REACT_APP_VSC_MARKET_INDEXER_URL  — optional Magi indexer base URL, e.g.
//       https://indexer.magi.milohpr.com. This is a magi-mongo-indexer instance
//       serving Hasura; the client appends /v1/graphql. It answers only what
//       contract state structurally cannot: distinct bettor counts, per-round
//       history, and the pool series behind the chart. Unset ⇒ those read as
//       UNKNOWN and render as such — never as zero.
//       Register prediction-market/magi-indexer/*.yaml with the instance first.
//   REACT_APP_VSC_MARKET_RC_LIMIT     — optional rc_limit override for bet/claim calls.
//
// When the contract id (or net id / gql url) is not set, getMarketConfig()
// returns null and getMarketDataSource() falls back to the Mock — so an
// un-provisioned build behaves exactly as it does today.

export interface MarketConfig {
  contractId: string;
  netId: string;
  gqlUrl: string;
  indexerUrl?: string;
  rcLimit?: number;
}

function readEnv(key: string): string | undefined {
  const value = env(key);
  return value && value.length > 0 ? value : undefined;
}

export function getMarketConfig(): MarketConfig | null {
  const contractId = readEnv('VSC_MARKET_CONTRACT_ID');
  const netId = readEnv('VSC_MARKET_NET_ID');
  const gqlUrl = readEnv('VSC_MARKET_GQL_URL');

  // Not provisioned → stay on the Mock. All three are required to talk to a
  // real contract; a partial config is treated as unconfigured.
  if (!contractId || !netId || !gqlUrl) return null;

  const rcLimitRaw = readEnv('VSC_MARKET_RC_LIMIT');
  const parsedRcLimit = rcLimitRaw !== undefined ? Number(rcLimitRaw) : undefined;
  const rcLimit = parsedRcLimit !== undefined && Number.isFinite(parsedRcLimit) ? parsedRcLimit : undefined;

  return {
    contractId,
    netId,
    gqlUrl: gqlUrl.replace(/\/+$/, ''),
    indexerUrl: readEnv('VSC_MARKET_INDEXER_URL')?.replace(/\/+$/, ''),
    rcLimit
  };
}

/**
 * Local-development ONLY escape hatch. When no real contract is configured
 * (getMarketConfig() === null) AND REACT_APP_MARKET_DEMO=1, getMarketDataSource()
 * serves the in-memory Mock so the UI can be worked on without a deployed
 * contract. This must NEVER be set on a production build: the default
 * unconfigured state is honest-unavailable, not a bettable mock. The Mock serves
 * a fabricated round and persists a fake bet position — acting on it would be a
 * lie. See getMarketDataSource().
 */
export function isMarketDemoEnabled(): boolean {
  return readEnv('MARKET_DEMO') === '1';
}
