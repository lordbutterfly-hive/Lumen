import type { Metadata } from 'next';
import WalletShell from '@/blog/features/wallet/components/wallet-shell';

export const metadata: Metadata = {
  title: 'Wallet',
  description: 'Your Hive balances, transfers and savings on Lumen.'
};

export default function WalletPage() {
  return <WalletShell />;
}
