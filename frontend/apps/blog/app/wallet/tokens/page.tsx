import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import YourTokensView from '@/blog/features/creator-tokens/ui/your-tokens/your-tokens-view';
import { getServerSessionUser, loginRedirectFor } from '@/blog/lib/server-session';

export const metadata: Metadata = {
  title: 'Your tokens',
  description:
    'Your portfolio of creator tokens on Lumen: value, floor value, buy/sell/spend, and the services you’ve spent tokens on.'
};

// "Your tokens" is a portfolio: there is nothing to render for somebody with no
// account. Same server-side gate as /wallet and /profile, carrying the way back.
export default async function YourTokensPage() {
  const session = await getServerSessionUser();
  if (!session.isLoggedIn) redirect(loginRedirectFor('/wallet/tokens'));

  return <YourTokensView />;
}
