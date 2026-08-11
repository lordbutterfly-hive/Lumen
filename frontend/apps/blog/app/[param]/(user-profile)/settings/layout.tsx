import { Metadata } from 'next';
import { siteConfig } from '@ui/config/site';
import { isBannedAuthor } from '@/blog/lib/moderation/banned-authors';
import React, { ReactNode } from 'react';
import ProfileSubpageShell from '@/blog/features/layouts/user-profile/profile-subpage-shell';
import { extractUsernameFromParam } from '@/blog/utils/validate-links';

export async function generateMetadata({ params }: { params: { param: string } }): Promise<Metadata> {
  const username = params?.param?.startsWith('%40') ? params.param.replace('%40', '') : params.param;

  // See followers/layout.tsx: the title is built from the URL alone, so it
  // renders a banned account's name even on the 404 this route serves.
  if (isBannedAuthor(username)) return { title: siteConfig.name };
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
    <ProfileSubpageShell username={username} page="settings">
      {children}
    </ProfileSubpageShell>
  );
}
