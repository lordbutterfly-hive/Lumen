/**
 * The wallet page's three in-page tabs (owner ruling 2026-09-08: "Obviously it
 * has to be B2", order Hive, Magi, Meritum, labels without "On").
 *
 * Shared by the server page (which reads `?tab=` and picks the default per
 * account tier) and the client tab bar, so the two can never disagree about
 * what a valid tab is. No React in here on purpose.
 */
export type WalletTab = 'hive' | 'magi' | 'meritum';

export const WALLET_TABS: readonly WalletTab[] = ['hive', 'magi', 'meritum'];

export function parseWalletTab(raw: unknown): WalletTab | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && (WALLET_TABS as readonly string[]).includes(value) ? (value as WalletTab) : null;
}

/**
 * Where the rail's Wallet row lands when no tab is asked for: the tab that
 * carries the account's base money. A full Hive account has its Hive balances;
 * a lite account (wallet-backed or Google-only) has no Hive wallet at all, so
 * Magi is its first page.
 */
export function defaultWalletTab(accountTier: 'lite' | 'full' | null): WalletTab {
  return accountTier === 'lite' ? 'magi' : 'hive';
}

export function walletTabHref(tab: WalletTab): string {
  return tab === 'hive' ? '/wallet' : `/wallet?tab=${tab}`;
}
