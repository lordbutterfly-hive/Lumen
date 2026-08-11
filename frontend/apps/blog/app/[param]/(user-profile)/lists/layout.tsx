import { Metadata } from 'next';
import React, { ReactNode } from 'react';
import ProfileSubpageShell from '@/blog/features/layouts/user-profile/profile-subpage-shell';
import { extractUsernameFromParam } from '@/blog/utils/validate-links';

const title = `Manage Lists`;

export async function generateMetadata(): Promise<Metadata> {
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
    <ProfileSubpageShell username={username} page="lists">
      {children}
    </ProfileSubpageShell>
  );
}
