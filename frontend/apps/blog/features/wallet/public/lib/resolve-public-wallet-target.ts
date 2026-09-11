import 'server-only';
import { liteAccountAsProfile } from '@/blog/lib/lite/render/lite-account';
import { isKeylessLiteName } from '@/blog/lib/lite/render/lite-identity';
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
  /**
   * ★★★ ASK WHOSE NAME THIS IS BEFORE ASKING THE CHAIN WHAT IT HOLDS (2026-09-11).
   *
   * The `not_found` branch below is the only path to `kind: 'lite'`, and a SQUATTED
   * name is never not-found: a real Hive account of that name exists, so
   * `readPublicWalletSummary` succeeded and this returned `kind: 'hive'` with the
   * squatter's balances seeded, under the victim's URL. Measured on production
   * 2026-09-11: `/@chadmasters/wallet` and `/@luxattack/wallet` both served
   * `"target":"hive"` while the uncontested control `/@arsha/wallet` correctly served
   * `"target":"lite"`.
   *
   * This is the wallet page. Its entire job is to tell a visitor whose account they
   * are looking at, and a visitor may well be checking a balance before sending
   * someone money. Being wrong about the owner here is the most expensive place in the
   * product to be wrong about the owner, so the ownership question is answered FIRST
   * and from our own records, not inferred from whether the chain happened to have
   * something under that string.
   *
   * `isKeylessLiteName` and not `liteAccountAsProfile`: an UPGRADED user owns both the
   * lite row and a real Hive account, and their real chain balances are exactly what
   * this page should show. Only an account with no chain identity at all takes the
   * lite branch.
   */
  if (await isKeylessLiteName(name)) return { kind: 'lite' };

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
