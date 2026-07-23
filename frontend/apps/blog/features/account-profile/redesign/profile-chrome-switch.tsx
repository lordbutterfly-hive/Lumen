'use client';

import { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import ProfileLayout from '@/blog/features/layouts/user-profile/profile-layout';

/**
 * The (user-profile) route group's layout.tsx wraps EVERY sub-route (posts,
 * replies, notifications, settings, communities, followers, followed,
 * lists, payout, comments, ...) in the legacy `ProfileLayout` chrome (dark
 * cover banner + stat grid + tab nav). The redesigned profile
 * (design-handoff-v2, Profile.dc.html) supplies its own cover, identity,
 * stats and tabs — but ONLY for the root `/@username` page. Every other
 * sub-route is untouched legacy UI and keeps the old chrome until it gets
 * its own redesign pass, so this switch is the single, narrow seam between
 * the two: it renders children bare (no chrome) on the exact root path, and
 * falls back to `ProfileLayout` everywhere else.
 */
export default function ProfileChromeSwitch({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '';
  const segments = pathname.split('/').filter(Boolean);
  const isRootProfilePage = segments.length === 1 && (segments[0].startsWith('@') || segments[0].startsWith('%40'));

  if (isRootProfilePage) {
    return <>{children}</>;
  }
  return <ProfileLayout>{children}</ProfileLayout>;
}
