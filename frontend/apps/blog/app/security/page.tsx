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
  // ★ THIS ROUTE HAS NO SHELL, SO IT OWNS ITS OWN LANDMARK (2026-08-13).
  // The root layout's outer wrapper was changed from <main> to <div> today,
  // because every SHELLED route (home, profile, post, search…) renders its own
  // <main> and the outer one produced a <main> inside a <main> on all of them.
  // These few routes have no shell — their only landmark WAS the outer one — so
  // that change left them with none at all, which is worse than the nesting it
  // removed. Verified live: /login /security /upgrade /privacy.html /tos.html all
  // returned zero <main> before this.
  return (
    <main>
      <SecurityPanel />
    </main>
  );
}
