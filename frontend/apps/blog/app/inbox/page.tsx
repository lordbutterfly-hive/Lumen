import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import InboxPage from '@/blog/features/direct-messages/ui/inbox-page';
import { getServerSessionUser, loginRedirectFor } from '@/blog/lib/server-session';

export const metadata: Metadata = {
  title: 'Inbox',
  description: 'Your private messages and your Meritum asks on Lumen.'
};

/**
 * /inbox: every signed-in account's direct messages (owner, 2026-09-25: "give
 * everyone a inbox top right"). The header's inbox control, the bell's "New message"
 * rows and the Meritum order popup's Message pill all land here.
 *
 * `?to=<account>` (a handle, `hive:<name>` or a wallet `did:pkh:…`) opens the
 * conversation with that person, or compose when there is none yet. `?view=asks` opens
 * the Asks tab (the bell's Meritum rows and the "Request placed" receipt link there).
 *
 * A signed-out visitor gets the door, decided on the server from the session cookie
 * like /wallet and /creators/studio, and `?next=` brings them back here, `to` included.
 */
export default async function InboxRoute({
  searchParams
}: {
  searchParams?: { [key: string]: string | string[] | undefined };
}) {
  const to = typeof searchParams?.to === 'string' && searchParams.to.trim() ? searchParams.to.trim() : null;
  // A conversation named by `to` is a message, whatever else the link says.
  const view = !to && searchParams?.view === 'asks' ? 'asks' : 'messages';
  const session = await getServerSessionUser();
  if (!session.isLoggedIn) {
    redirect(loginRedirectFor(to ? `/inbox?to=${encodeURIComponent(to)}` : view === 'asks' ? '/inbox?view=asks' : '/inbox'));
  }

  return <InboxPage to={to} view={view} />;
}
