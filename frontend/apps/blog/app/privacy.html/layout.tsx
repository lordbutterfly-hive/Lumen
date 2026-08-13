import { Metadata } from 'next';
import React, { PropsWithChildren } from 'react';

export const metadata: Metadata = {
  title: 'Privacy Policy'
};

export default function Layout({ children }: PropsWithChildren) {
  // ★ THIS ROUTE HAS NO SHELL, SO IT OWNS ITS OWN LANDMARK (2026-08-13).
  // The root layout's outer wrapper was changed from <main> to <div> today,
  // because every SHELLED route (home, profile, post, search…) renders its own
  // <main> and the outer one produced a <main> inside a <main> on all of them.
  // These few routes have no shell — their only landmark WAS the outer one — so
  // that change left them with none at all, which is worse than the nesting it
  // removed. Verified live: /login /security /upgrade /privacy.html /tos.html all
  // returned zero <main> before this.
  return <main>{children}</main>;
}
