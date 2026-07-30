import { Metadata } from 'next';
import React, { PropsWithChildren } from 'react';
import { siteConfig } from '@ui/config/site';

export const metadata: Metadata = {
  title: `My Community / Muted - ${siteConfig.name}`
};

export default function Layout({ children }: PropsWithChildren) {
  return <>{children}</>;
}
