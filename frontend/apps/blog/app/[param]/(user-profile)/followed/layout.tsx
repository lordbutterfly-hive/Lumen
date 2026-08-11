import { Metadata } from 'next';
import { isBannedAuthor } from '@/blog/lib/moderation/banned-authors';
import React, { ReactNode } from 'react';
import ProfileSubpageShell from '@/blog/features/layouts/user-profile/profile-subpage-shell';
import { extractUsernameFromParam } from '@/blog/utils/validate-links';

export async function generateMetadata({ params }: { params: { param: string } }): Promise<Metadata> {
  const username = params?.param?.startsWith('%40') ? params.param.replace('%40', '') : params.param;
  // The route 404s in the profile layout, but this title is generated
  // independently from the URL alone — with no chain lookup to fail — so a
  // banned account's NAME was still rendered into the browser tab and the
  // share preview of the not-found page. The body carried no data; the name
  // is the thing being banned, so it goes too.
  // ★ NOT `siteConfig.name` (audit item 15) — the root layout's `%s - Lumen`
  // template turns the bare site name into "Lumen - Lumen" in the tab.
  if (isBannedAuthor(username)) return { title: 'People followed' };
  const title = `People followed by ${username}`;

  return {
    title
  };
}

// The shell is mounted BY THIS ROUTE — see profile-subpage-shell.tsx for why
// the legacy pathname switch that used to pick the chrome had to go.
export default function Layout({
  children,
  params
}: {
  children: ReactNode;
  params: { param: string };
}) {
  const username = extractUsernameFromParam(params.param) ?? '';
  return (
    <ProfileSubpageShell username={username} page="followed">
      {children}
    </ProfileSubpageShell>
  );
}
