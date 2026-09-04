import { getAccount, getDynamicGlobalProperties, getFindAccounts } from '@transaction/lib/hive-api';
import { getChain } from '@transaction/lib/chain';
import { getLogger } from '@ui/lib/logging';
import { cachedRead } from '@/blog/lib/server-read-cache';
import { deriveWalletFigures } from './wallet-derived';
import { toWalletFiguresWire } from './wallet-figures-wire';
import type { WalletSummaryWire } from './wallet-summary-wire';

const logger = getLogger('app');

/**
 * SERVER-ONLY. Same shape check, same reads and the same derivation
 * `/api/wallet/summary/route.ts` makes, called directly from the wallet's
 * server component (T3g, 2026-09-04) so the masthead and balances can
 * SSR-render instead of the client mounting on a bare skeleton and fetching
 * afterwards (462ms warm, up to 11.65s cold - see that route's own comment
 * for the full "getAccount not getAccountFull" story and the 12
 * bannedFollowEdges calls this already avoids).
 *
 * Deliberately duplicated rather than imported from the route: this file
 * lives under `features/wallet/`, the route under `app/api/wallet/`, and
 * this task's slice is scoped to the former only.
 *
 * Shares that route's exact cache key (`wallet:summary:<username>`) and TTL
 * via the same `cachedRead` memo, so this SSR read and the client's own
 * unconditional first `/api/wallet/summary` call (fired by `useWalletAccount`
 * on mount) usually collapse into ONE upstream read rather than two.
 *
 * Never throws. A wallet is money-adjacent: the one thing worse than a
 * loading state is a WRONG one, so any failure here just means "no seed" -
 * `WalletContent`'s existing unseeded loading path is exactly what runs next,
 * unchanged.
 */
const SUMMARY_MEMO_MS = 3_000;
const USERNAME_RE = /^[a-z][a-z0-9.-]{1,15}$/;

export async function fetchWalletSummarySeed(username: string): Promise<WalletSummaryWire | null> {
  if (!USERNAME_RE.test(username)) return null;
  try {
    return await cachedRead(`wallet:summary:${username}`, SUMMARY_MEMO_MS, async () => {
      const [account, dynamicGlobal, raw, chain] = await Promise.all([
        getAccount(username),
        getDynamicGlobalProperties(),
        getFindAccounts(username),
        getChain()
      ]);
      if (!account) throw new Error(`no account for ${username}`);
      const summary: WalletSummaryWire = {
        account,
        dynamicGlobal,
        figures: toWalletFiguresWire(deriveWalletFigures(account, dynamicGlobal, chain)),
        pendingClaimedAccounts: Number(raw?.accounts?.[0]?.pending_claimed_accounts ?? 0)
      };
      return summary;
    });
  } catch (error) {
    logger.warn(error, 'wallet summary seed failed for %s; client will fetch it instead', username);
    return null;
  }
}
