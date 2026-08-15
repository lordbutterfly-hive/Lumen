import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { MeritumLaunchFlow } from '@/blog/features/creator-tokens/ui/meritum/launch';
import { getServerSessionUser, loginRedirectFor } from '@/blog/lib/server-session';

export const metadata: Metadata = {
  title: 'Launch your Meritum',
  description: 'Launch your Meritum on Lumen. Name three offers, price them, and strike the coin.'
};

// ★★★ SIGNED-OUT VISITOR GETS THE DOOR, NOT A BROKEN WIZARD (2026-08-11).
// Same treatment as `app/profile/page.tsx`, `app/wallet/page.tsx` and
// `app/creators/studio/page.tsx` — decided on the server from the session
// cookie, `?next=` carries the destination back. UNCHANGED by the 2026-08-15
// screen rebuild: the gate is the reason a launch flow can assume an account.
export default async function LaunchPage() {
  const session = await getServerSessionUser();
  if (!session.isLoggedIn) redirect(loginRedirectFor('/creators/launch'));

  // ★ THE SCREEN CHANGED, THE LAUNCH PATH DID NOT. `MeritumLaunchFlow` calls
  // the same `useLiveStudio().register` + `createOffering` the previous wizard
  // called, behind the same gates. That wizard is still mounted, one route
  // along, at `/creators/launch/classic`.
  return <MeritumLaunchFlow />;
}
