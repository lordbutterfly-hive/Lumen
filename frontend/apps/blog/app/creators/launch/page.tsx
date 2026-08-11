import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import LaunchWizard from '@/blog/features/creator-tokens/ui/studio/launch-wizard';
import { getServerSessionUser, loginRedirectFor } from '@/blog/lib/server-session';

export const metadata: Metadata = {
  title: 'Launch your token',
  description: 'Launch your creator token on Lumen — set your service prices, choose your supply, and go live.'
};

// ★★★ SIGNED-OUT VISITOR GETS THE DOOR, NOT A BROKEN WIZARD (2026-08-11).
// Same treatment as `app/profile/page.tsx`, `app/wallet/page.tsx` and
// `app/creators/studio/page.tsx` — decided on the server from the session
// cookie, `?next=` carries the destination back.
export default async function LaunchPage() {
  const session = await getServerSessionUser();
  if (!session.isLoggedIn) redirect(loginRedirectFor('/creators/launch'));

  return <LaunchWizard />;
}
