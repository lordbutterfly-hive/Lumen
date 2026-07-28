import { Metadata } from 'next';
import SecurityPanel from '@/blog/features/lite-auth/security/security-panel';

export const metadata: Metadata = {
  title: 'Sign-in & recovery',
  description: 'See how you can sign in to your Lumen account, and add another way in case you lose one.'
};

/**
 * Account recovery for lite accounts. `/api/lite/auth/{stepup,bind}` have been able to
 * link a second credential since Phase 2 with nothing in the product reaching them, so
 * every lite user had exactly one way in and was never told what that meant.
 */
export default function SecurityPage() {
  return <SecurityPanel />;
}
