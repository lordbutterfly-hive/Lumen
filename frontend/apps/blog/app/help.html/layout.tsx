import { Metadata } from 'next';
import React, { PropsWithChildren } from 'react';

export const metadata: Metadata = {
  title: 'Help',
  description:
    'How Lumen works for a new account: signing in without keys or a wallet, what happens when you post, and where your post goes.'
};

export default function Layout({ children }: PropsWithChildren) {
  return <>{children}</>;
}
