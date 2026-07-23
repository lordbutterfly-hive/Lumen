import type { Metadata } from 'next';
import YourTokensView from '@/blog/features/creator-tokens/ui/your-tokens/your-tokens-view';

export const metadata: Metadata = {
  title: 'Your tokens',
  description: 'Your portfolio of creator tokens on Lumen — value, floor value, buy/sell/spend, and the services you’ve spent tokens on.'
};

export default function YourTokensPage() {
  return <YourTokensView />;
}
