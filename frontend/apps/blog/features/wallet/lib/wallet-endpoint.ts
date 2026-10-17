import env from '@beam-australia/react-env';

/**
 * Base URL of the standalone @hive/wallet deployment (wallet.openhive.network
 * in production — see REACT_APP_WALLET_ENDPOINT). Same env var left-rail.tsx
 * already reads. A few power-user flows this page doesn't rebuild locally
 * (full delegation management, deep market stats) link out to the real,
 * already-deployed pages there instead of dead-ending on "#".
 *
 * env() reads the client-only __ENV, so it is undefined during SSR — callers
 * get '' until hydration, matching the left-rail precedent.
 */
export function getWalletHost(): string {
  return env('WALLET_ENDPOINT') || '';
}

export function getDelegationsUrl(username: string): string {
  const host = getWalletHost();
  return host ? `${host}/@${username}/delegations` : '#';
}

/**
 * Where "Trade" on the HIVE and HBD cards goes: HiveHub's swap page on the
 * Hive internal market (HIVE <-> HBD). Same destination PeakD's wallet uses for
 * its "Market" action on both tokens. The route takes no query parameters, so
 * the reader picks the direction and amount there; it signs with their own
 * Keychain / HiveSigner, nothing passes through Lumen.
 */
export const HIVE_MARKET_SWAP_URL = 'https://hivehub.dev/market/swap';

export function getMarketStatsUrl(): string {
  const host = getWalletHost();
  return host ? `${host}/market` : '#';
}

/**
 * Full account-history / transfers page on the standalone wallet app
 * (apps/wallet's `app/[param]/transfers`). The Lumen wallet's own "Recent
 * activity" card only ever shows the most recent page — this is where
 * "View full history" sends someone who wants everything, same pattern as
 * `getDelegationsUrl` above.
 */
export function getTransfersUrl(username: string): string {
  const host = getWalletHost();
  return host ? `${host}/@${username}/transfers` : '#';
}
