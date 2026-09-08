import 'server-only';
import { getAccounts } from '@transaction/lib/hive-api';
import { siteConfig } from '@ui/config/site';
import { cachedRead } from '@/blog/lib/server-read-cache';

/**
 * "This account does not exist on the chain this server reads" — as a fact the
 * three /api/wallet/* routes can answer with 404 instead of a 502 that reads
 * like an outage (F1, 2026-09-08).
 *
 * WHY THIS IS A SEPARATE, MEMOISED READ. The routes' upstream calls do not all
 * fail for a missing account: `find_accounts` yields nothing (summary derived
 * figures from `undefined` and blew up into the catch-all 502), while
 * `accountsOperations` and `list_vesting_delegations` answer an empty list for
 * a name that was never registered — an honest-looking empty wallet for an
 * account that is not there. One existence read, keyed by name and memoised
 * for the same 3s the summary uses, collapses the three routes' checks of one
 * render into a single upstream `find_accounts` (server-read-cache.ts dedupes
 * in-flight readers by key).
 *
 * `withHiveRetry` inside `getAccounts` retries only when the node could not be
 * reached; a node that answered "no such account" is never asked twice. So a
 * thrown error here is a genuine upstream failure (502 at the route), and a
 * `false` is a definite absence (404).
 */
const EXISTS_MEMO_MS = 3_000;

export class HiveAccountNotFoundError extends Error {
  readonly username: string;
  readonly chain: string;
  constructor(username: string) {
    super(`account_not_found: @${username} does not exist on ${siteConfig.chainEnv}`);
    this.name = 'HiveAccountNotFoundError';
    this.username = username;
    this.chain = siteConfig.chainEnv;
  }
}

export async function hiveAccountExists(username: string): Promise<boolean> {
  return cachedRead(`wallet:exists:${username}`, EXISTS_MEMO_MS, async () => {
    const accounts = await getAccounts([username]);
    return accounts.length > 0 && accounts[0]?.name === username;
  });
}

/** Throws HiveAccountNotFoundError for a definite absence; rethrows upstream failures untouched. */
export async function assertHiveAccountExists(username: string): Promise<void> {
  if (!(await hiveAccountExists(username))) throw new HiveAccountNotFoundError(username);
}

/** The JSON body every wallet route answers a missing account with. */
export function accountNotFoundBody(error: HiveAccountNotFoundError) {
  return { error: 'account_not_found' as const, chain: error.chain, chainId: siteConfig.chainId, username: error.username };
}
