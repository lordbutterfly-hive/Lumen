import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import WalletShell from '@/blog/features/wallet/components/wallet-shell';
import { getServerSessionUser, loginRedirectFor } from '@/blog/lib/server-session';
import { fetchWalletSummarySeed } from '@/blog/features/wallet/lib/wallet-summary-seed';
import { WalletSummaryProvider } from '@/blog/features/wallet/lib/wallet-summary-context';

export const metadata: Metadata = {
  title: 'Wallet',
  description: 'Your Hive balances, transfers and savings on Lumen.'
};

/**
 * How long the wallet page will wait for its SSR balance prefetch before
 * sending the page anyway (T3g, 2026-09-04). Sized against the measured
 * "warm" cost of `/api/wallet/summary` (462ms) with some headroom, well short
 * of its measured cold tail (up to 11.65s) - that route's own comment on why
 * it can be that slow (a rate-limited or degraded upstream node). Whatever
 * has not resolved by the deadline just isn't seeded: `WalletContent` already
 * has a correct, unseeded loading path for exactly that case, so this can
 * only ever help TTFB, never hurt it. Same reasoning and shape as the profile
 * layout's own `PREFETCH_BUDGET_MS` (app/[param]/(user-profile)/layout.tsx).
 */
const PREFETCH_BUDGET_MS = 600;

/**
 * ★★★ /wallet IS AN ACCOUNT PAGE, SO A SIGNED-OUT READER GETS THE DOOR (2026-08-10).
 *
 * The Wallet row is in the left rail for everyone, signed in or not. Clicking it
 * signed out reached a page with nothing on it but a dialog trigger, and no way
 * to come back here afterwards, so signing in from there dropped the reader on
 * the feed having forgotten what they were trying to do.
 *
 * Exactly the treatment `app/profile/page.tsx` already gets: decided on the
 * server from the session cookie, so there is no flash of an empty wallet first,
 * and `?next=` carries the destination so signing in returns them here.
 */
export default async function WalletPage() {
  const session = await getServerSessionUser();
  if (!session.isLoggedIn) redirect(loginRedirectFor('/wallet'));

  /**
   * ★★★ THE PAGE ALREADY KNEW THE USERNAME; NOTHING FETCHED WITH IT (T3g,
   * 2026-08-11 comment below / fixed 2026-09-04).
   *
   * `session.username` is already proven signed-in above. A lite account (no
   * real Hive account) also has a `username` here, so this races the SAME
   * bounded window regardless of tier: `fetchWalletSummarySeed` resolves null
   * for a name with no chain account, exactly like any other failure — see
   * the null-guard in `useWalletAccount` (`seed.account.name === username`),
   * which only ever seeds a FULL account's own matching query.
   *
   * Race, don't await: a healthy read lands well inside the budget and this
   * page gets the full no-flash benefit; a degraded one just means no seed,
   * never a slow page. Deliberately not cancelled on timeout — see
   * `fetchWalletSummarySeed`'s own `cachedRead` memo, which a slow read still
   * warms for the client's own imminent `/api/wallet/summary` call.
   */
  const seed = await Promise.race([
    fetchWalletSummarySeed(session.username),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), PREFETCH_BUDGET_MS))
  ]);

  return (
    <WalletSummaryProvider value={seed}>
      <WalletShell />
    </WalletSummaryProvider>
  );
}
