import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import LaunchWizard from '@/blog/features/creator-tokens/ui/studio/launch-wizard';
import { getServerSessionUser, loginRedirectFor } from '@/blog/lib/server-session';

export const metadata: Metadata = {
  title: 'Launch your Meritum · classic form',
  description: 'The plain three-step form for launching your Meritum on Lumen.'
};

/**
 * ★ THE FLOW THAT HAS BEEN LAUNCHING REAL TOKENS, KEPT REACHABLE (2026-08-15).
 *
 * `/creators/launch` now renders the Meritum launch screen. That screen calls
 * the SAME chain path this one does — `useLiveStudio().register` followed by a
 * `createOffering` per named offer — behind the same gates, so nothing was
 * traded away for the new design. This route exists anyway, for two honest
 * reasons: the wizard is the version with real mileage on it, and a creator who
 * cannot complete a press-and-hold has a plain form to fall back to.
 *
 * The auth gate is identical to the one on `/creators/launch`; a launch flow
 * with no account behind it is not a flow, it is a demo.
 */
export default async function ClassicLaunchPage() {
  const session = await getServerSessionUser();
  if (!session.isLoggedIn) redirect(loginRedirectFor('/creators/launch/classic'));

  return <LaunchWizard />;
}
