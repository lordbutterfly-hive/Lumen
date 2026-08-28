import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import CreatorStudio from '@/blog/features/creator-tokens/ui/studio/creator-studio';
import { getServerSessionUser, loginRedirectFor } from '@/blog/lib/server-session';

export const metadata: Metadata = {
  title: 'Creator Studio',
  description:
    'Launch and manage your Meritum on Lumen: set service prices, answer requests, manage your market, subscription, and earnings.'
};

// A static segment, so it takes precedence over the /creators/[handle] dynamic
// route — /creators/studio now renders the Studio instead of a default token page.
//
// ★★★ SIGNED-OUT VISITOR GETS THE DOOR, NOT A BROKEN STUDIO (2026-08-11).
// Never checked `isLoggedIn` — a signed-out reader reached the client
// component directly and got whatever CreatorStudio's own loading/empty
// states happened to render for a visitor it was never built to expect at
// the top of the page. Exactly the treatment `app/profile/page.tsx` and
// `app/wallet/page.tsx` already get: decided on the server from the session
// cookie, so there is no flash of the wrong page, and `?next=` carries the
// destination so signing in returns them here.
export default async function CreatorStudioPage() {
  const session = await getServerSessionUser();
  if (!session.isLoggedIn) redirect(loginRedirectFor('/creators/studio'));

  return <CreatorStudio />;
}
