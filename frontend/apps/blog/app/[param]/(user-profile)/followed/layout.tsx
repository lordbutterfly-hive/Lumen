import { Metadata } from 'next';
import { siteConfig } from '@ui/config/site';
import { isBannedAuthor } from '@/blog/lib/moderation/banned-authors';
import React, { PropsWithChildren } from 'react';

export async function generateMetadata({ params }: { params: { param: string } }): Promise<Metadata> {
  const username = params?.param?.startsWith('%40') ? params.param.replace('%40', '') : params.param;
  // The route 404s in the profile layout, but this title is generated
  // independently from the URL alone — with no chain lookup to fail — so a
  // banned account's NAME was still rendered into the browser tab and the
  // share preview of the not-found page. The body carried no data; the name
  // is the thing being banned, so it goes too.
  if (isBannedAuthor(username)) return { title: siteConfig.name };
  const title = `People followed by ${username}`;

  return {
    title
  };
}

export default function Layout({ children }: PropsWithChildren) {
  return <>{children}</>;
}
