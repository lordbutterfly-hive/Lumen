import { Metadata } from 'next';
import WitnessesShell from '@/blog/features/witnesses/witnesses-shell';

export const metadata: Metadata = {
  title: 'Witnesses'
};

export default function WitnessesPage() {
  return <WitnessesShell />;
}
