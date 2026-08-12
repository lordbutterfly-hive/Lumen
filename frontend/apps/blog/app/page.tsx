import { cookies } from 'next/headers';
import { getIronSession } from 'iron-session';
import { sessionOptions } from '@smart-signer/lib/session';
import { applyHiveSessionTtl } from '@smart-signer/lib/get-session';
import type { IronSessionData } from '@smart-signer/types/common';
import { getLogger } from '@ui/lib/logging';
import HomeShell from '@/blog/features/discovery-feed/home-shell';

const logger = getLogger('app');

/**
 * Decided SERVER-side, on the session cookie, so the orientation line is either
 * in the first paint or absent from it. The client-side alternative
 * (`useUserClient`) cannot know before hydration, and both of its guesses are
 * visibly wrong: render-by-default flashes a "welcome, this is Lumen" card at a
 * signed-in reader on every load, and render-after-hydration hides it from the
 * crawler and from exactly the slow connection most likely to need it.
 *
 * The root layout already calls `cookies()`, so this route is dynamic either way
 * — reading the session here costs nothing that was not already being paid.
 */
async function hasSession(): Promise<boolean> {
  // ★ OUTSIDE the try, deliberately. During `next build` this call throws a
  // DynamicServerError on purpose — that throw is how a route announces it cannot
  // be prerendered. Swallowing it in a catch turns a framework signal into two
  // ERROR log lines and leaves the route's dynamism resting on the fact that the
  // root layout happens to read cookies too.
  const cookieStore = cookies();
  try {
    const session = await getIronSession<IronSessionData>(cookieStore, sessionOptions);
    // F-L40 (2026-08-12): a sealed Hive session cookie carries no expiry of its
    // own (see get-session.ts's doc comment) — without this call a 400-day-old
    // cookie still read as signed in here, hiding the sign-in intro from a
    // visitor who should be seeing it. `canPersist: false`: this runs inside a
    // Server Component render, where Next.js forbids writing cookies.
    await applyHiveSessionTtl(session, { canPersist: false });
    return Boolean(session.user?.isLoggedIn);
  } catch (error) {
    // A malformed or rotated cookie must not take the home page down. Treating the
    // reader as signed out shows one extra card; throwing shows an error page.
    logger.error(error, 'home: could not read session for the signed-out intro');
    return false;
  }
}

export default async function HomePage() {
  const signedIn = await hasSession();
  // The intro is passed DOWN rather than rendered beside the shell: it belongs
  // inside the feed column, aligned with the composer and the cards, and the shell
  // is what owns that column (fuckery list E1).
  return <HomeShell showIntro={!signedIn} />;
}
