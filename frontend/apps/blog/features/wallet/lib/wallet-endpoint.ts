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
