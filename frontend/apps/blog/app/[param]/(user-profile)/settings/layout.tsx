import { Metadata } from 'next';
import { siteConfig } from '@ui/config/site';
import { isBannedAuthor } from '@/blog/lib/moderation/banned-authors';
import React, { PropsWithChildren } from 'react';

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

export default function Layout({ children }: PropsWithChildren) {
  return <>{children}</>;
}
