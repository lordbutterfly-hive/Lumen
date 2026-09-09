import 'server-only';
import { liteAccountAsProfile } from '@/blog/lib/lite/render/lite-account';
import type { WalletSummaryWire } from '@/blog/features/wallet/lib/wallet-summary-wire';
import { readPublicWalletSummary } from './read-public-wallet-summary';

/**
 * Read-only composition of two patterns already in this codebase, for the
 * public wallet page. It borrows the timed seed race app/wallet/page.tsx
 * runs before rendering, and the not found then lite account fallback the
 * profile layout already applies to an arbitrary name. Nothing is removed
 * from either pattern; this file is new because the public page needs to
 * answer a question the private wallet never asks: whose wallet is this, a
 * Hive account, a lite account, or nobody.
 */
const TARGET_TIMEOUT_MS = 600;

export type PublicWalletTarget =
  | { kind: 'hive'; seed: WalletSummaryWire | null }
  | { kind: 'lite' }
  | { kind: 'none' };

export async function resolvePublicWalletTarget(name: string): Promise<PublicWalletTarget> {
  const result = await Promise.race([
    readPublicWalletSummary(name),
    new Promise<{ status: 'timeout' }>((resolve) =>
      setTimeout(() => resolve({ status: 'timeout' }), TARGET_TIMEOUT_MS)
    )
  ]);

  if (result.status === 'ok') return { kind: 'hive', seed: result.seed };

  if (result.status === 'not_found') {
    const lite = await liteAccountAsProfile(name);
    return lite ? { kind: 'lite' } : { kind: 'none' };
  }

  // error | timeout: never 404 on a chain failure. The client's own
  // /api/wallet/summary call decides from here, and PublicHivePanel shows
  // the honest failure copy instead of claiming the account does not exist.
  return { kind: 'hive', seed: null };
}
