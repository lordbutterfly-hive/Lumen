import type { Metadata } from 'next';
import LaunchWizard from '@/blog/features/creator-tokens/ui/studio/launch-wizard';

export const metadata: Metadata = {
  title: 'Launch your token',
  description: 'Launch your creator token on Lumen — set your service prices, choose your supply, and go live.'
};

export default function LaunchPage() {
  return <LaunchWizard />;
}
