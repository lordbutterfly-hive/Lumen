import { Metadata } from 'next';
import WitnessesShell from '@/blog/features/witnesses/witnesses-shell';

export const metadata: Metadata = {
  title: 'Vote Witness'
};

export default function WitnessesPage() {
  return <WitnessesShell />;
}
