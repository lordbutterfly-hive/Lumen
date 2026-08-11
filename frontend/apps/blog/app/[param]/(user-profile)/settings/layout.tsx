import { Metadata } from 'next';
import { isBannedAuthor } from '@/blog/lib/moderation/banned-authors';
import React, { ReactNode } from 'react';
import ProfileSubpageShell from '@/blog/features/layouts/user-profile/profile-subpage-shell';
import { extractUsernameFromParam } from '@/blog/utils/validate-links';

export async function generateMetadata({ params }: { params: { param: string } }): Promise<Metadata> {
  const username = params?.param?.startsWith('%40') ? params.param.replace('%40', '') : params.param;

  // See followers/layout.tsx: the title is built from the URL alone, so it
  // renders a banned account's name even on the 404 this route serves.
  // ★ NOT `siteConfig.name` (audit item 15) — the root layout's `%s - Lumen`
  // template turns the bare site name into "Lumen - Lumen" in the tab.
  if (isBannedAuthor(username)) return { title: 'Settings' };
  const title = `Settings ${username}`;

  return {
    title
  };
}

// The shell is mounted BY THIS ROUTE, so `/@username/settings` can only ever
// wear the settings chrome — see profile-subpage-shell.tsx for why the old
// pathname switch had to go.
export default function Layout({
  children,
  params
}: {
  children: ReactNode;
  params: { param: string };
}) {
  const username = extractUsernameFromParam(params.param) ?? '';
  return (
    // ★ NOT THE FEED RAIL (audit item 13). Streak card, prediction market and
    // Topics belong to the reading surfaces, not to account settings — see
    // profile-subpage-shell.tsx's `rightRail` prop.
    <ProfileSubpageShell username={username} page="settings" rightRail={null}>
      {children}
    </ProfileSubpageShell>
  );
}
