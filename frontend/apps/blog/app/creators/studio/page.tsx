import type { Metadata } from 'next';
import CreatorStudio from '@/blog/features/creator-tokens/ui/studio/creator-studio';

export const metadata: Metadata = {
  title: 'Creator Studio',
  description:
    'Launch and manage your creator token on Lumen — set service prices, answer requests, manage your market, subscription, and earnings.'
};

// A static segment, so it takes precedence over the /creators/[handle] dynamic
// route — /creators/studio now renders the Studio instead of a default token page.
export default function CreatorStudioPage() {
  return <CreatorStudio />;
}
