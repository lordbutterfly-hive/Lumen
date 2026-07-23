import type { Metadata } from 'next';
import CreatorsView from '@/blog/features/creator-tokens/ui/creators/creators-view';

export const metadata: Metadata = {
  title: 'Discover creators',
  description:
    'Browse creators and their tokens on Lumen — ranked by how reliably they deliver. Hold a creator’s token and spend it on their work.'
};

export default function CreatorsPage() {
  return <CreatorsView />;
}
