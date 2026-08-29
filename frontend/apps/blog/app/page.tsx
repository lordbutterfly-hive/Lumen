import { cookies } from 'next/headers';
import { getIronSession } from 'iron-session';
import { sessionOptions } from '@smart-signer/lib/session';
import { applyHiveSessionTtl } from '@smart-signer/lib/get-session';
import type { IronSessionData } from '@smart-signer/types/common';
import { getLogger } from '@ui/lib/logging';
import HomeShell from '@/blog/features/discovery-feed/home-shell';
import { InitialFeedProvider } from '@/blog/components/observer-provider';
import { prefetchHomeFeed } from '@/blog/lib/feed/feed-prefetch';

const logger = getLogger('app');

async function readSession(): Promise<{ signedIn: boolean; viewer: string }> {
  const cookieStore = cookies();
  try {
    const session = await getIronSession<IronSessionData>(cookieStore, sessionOptions);
    await applyHiveSessionTtl(session, { canPersist: false });
    const signedIn = Boolean(session.user?.isLoggedIn);
    return { signedIn, viewer: signedIn ? (session.user?.username ?? '') : '' };
  } catch (error) {
    logger.error(error, 'home: could not read session');
    return { signedIn: false, viewer: '' };
  }
}

export default async function HomePage() {
  const { signedIn, viewer } = await readSession();
  const feed = await prefetchHomeFeed(viewer);
  return (
    <InitialFeedProvider value={feed}>
      <HomeShell showIntro={!signedIn} />
    </InitialFeedProvider>
  );
}
