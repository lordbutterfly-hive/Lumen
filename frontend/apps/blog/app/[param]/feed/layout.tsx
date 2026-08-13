import MainPageLayout from '@/blog/features/layouts/main-page-layout';
import ServerSideLayout from '@/blog/features/layouts/sorts/server-side-layout';
import { ReactNode } from 'react';
import { Metadata } from 'next';
import { extractUsernameFromParam } from '@/blog/utils/validate-links';
import { isBannedAuthor } from '@/blog/lib/moderation/banned-authors';

const tag = 'feed';

/**
 * ★ O6 build map item 5 (2026-08-13). This was a static `{ title: 'My Friends'
 * }` — every account's feed page wore the identical browser-tab title
 * regardless of whose feed it was. `generateMetadata` reads the route's own
 * `[param]`, same pattern as the sibling `(user-profile)/settings/layout.tsx`.
 * Plain string, not `t()` — this is a server file, same as before.
 *
 * Deliberately NOT viewer-aware (unlike the in-page heading in
 * `main-page-layout.tsx`, which distinguishes "my feed" from "someone else's
 * feed"): the build map's fix names the feed's OWNER, not who is looking at
 * it, and generateMetadata has no cheap access to the viewer's session here.
 */
export async function generateMetadata({ params }: { params: { param: string } }): Promise<Metadata> {
  const username = extractUsernameFromParam(params.param);
  // Same reasoning as settings/layout.tsx: the title is built from the URL
  // alone, so it must not name a banned account even on the 404 this route
  // otherwise serves via page.tsx's own ban gate.
  if (!username || isBannedAuthor(username)) return { title: 'My Friends' };
  return { title: `${username}'s Friends` };
}

const Layout = ({ children, params }: { children: ReactNode; params: { param: string } }) => {
  const username = extractUsernameFromParam(params.param);
  return (
    <ServerSideLayout>
      <MainPageLayout tag={tag} owner={username ?? undefined}>
        {children}
      </MainPageLayout>
    </ServerSideLayout>
  );
};

export default Layout;
