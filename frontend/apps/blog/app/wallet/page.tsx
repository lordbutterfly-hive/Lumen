import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import WalletShell from '@/blog/features/wallet/components/wallet-shell';
import { getServerSessionUser, loginRedirectFor } from '@/blog/lib/server-session';

export const metadata: Metadata = {
  title: 'Wallet',
  description: 'Your Hive balances, transfers and savings on Lumen.'
};

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

  return <WalletShell />;
}
