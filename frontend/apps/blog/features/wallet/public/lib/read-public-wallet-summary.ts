import 'server-only';
import { getAccount, getDynamicGlobalProperties, getFindAccounts } from '@transaction/lib/hive-api';
import { getChain } from '@transaction/lib/chain';
import { getLogger } from '@ui/lib/logging';
import { cachedRead } from '@/blog/lib/server-read-cache';
import { deriveWalletFigures } from '@/blog/features/wallet/lib/wallet-derived';
import { toWalletFiguresWire } from '@/blog/features/wallet/lib/wallet-figures-wire';
import type { WalletSummaryWire } from '@/blog/features/wallet/lib/wallet-summary-wire';
import { HiveAccountNotFoundError } from '@/blog/lib/wallet/hive-account-exists';

const logger = getLogger('app');

/**
 * Read-only copy of app/api/wallet/summary/route.ts's memo block, for the
 * public wallet page. Removed: the NextRequest and NextResponse plumbing,
 * since this is a plain function, not a route, and the flat 502 catch all. A
 * public reader that cannot tell an account that does not exist apart from a
 * chain that is unreachable would have nothing honest to show a Hive target
 * visitor, so this keeps that distinction as a three way result instead of
 * an HTTP status code. Per D12, this reads and writes the same wallet
 * summary memo key and the same WalletSummaryWire shape the route and the
 * private seed use, so one cache entry can serve all three callers.
 */
const SUMMARY_MEMO_MS = 3_000;
const RETRY_BACKOFF_MS = 200;
const USERNAME_RE = /^[a-z][a-z0-9.-]{1,15}$/;

export type PublicWalletSummaryResult =
  | { status: 'ok'; seed: WalletSummaryWire }
  | { status: 'not_found' }
  | { status: 'error' };

async function readSummaryOnce(name: string): Promise<WalletSummaryWire> {
  return cachedRead(`wallet:summary:${name}`, SUMMARY_MEMO_MS, async () => {
    const [account, dynamicGlobal, raw, chain] = await Promise.all([
      getAccount(name),
      getDynamicGlobalProperties(),
      getFindAccounts(name),
      getChain()
    ]);
    if (!account) throw new HiveAccountNotFoundError(name);
    const summary: WalletSummaryWire = {
      account,
      dynamicGlobal,
      figures: toWalletFiguresWire(deriveWalletFigures(account, dynamicGlobal, chain)),
      pendingClaimedAccounts: Number(raw?.accounts?.[0]?.pending_claimed_accounts ?? 0)
    };
    return summary;
  });
}

export async function readPublicWalletSummary(name: string): Promise<PublicWalletSummaryResult> {
  // A name this shape cannot exist on chain: the same regex the route uses to
  // reject a request outright, so it costs no upstream call here either.
  if (!USERNAME_RE.test(name)) return { status: 'not_found' };
  try {
    return { status: 'ok', seed: await readSummaryOnce(name) };
  } catch (firstError) {
    if (firstError instanceof HiveAccountNotFoundError) return { status: 'not_found' };
    logger.warn(firstError, 'public wallet summary read failed for %s; retrying once', name);
    await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS));
    try {
      return { status: 'ok', seed: await readSummaryOnce(name) };
    } catch (secondError) {
      if (secondError instanceof HiveAccountNotFoundError) return { status: 'not_found' };
      logger.error(secondError, 'public wallet summary read failed twice for %s', name);
      return { status: 'error' };
    }
  }
}
