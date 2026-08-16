import { Metadata } from 'next';
import UpgradePanel from '@/blog/features/lite-auth/upgrade/upgrade-panel';

export const metadata: Metadata = {
  title: 'Upgrade to a full Hive account',
  // ★ H8 (QA copy pass, 2026-08-16): was "...with your own keys, keeping your
  // posting history" — that overpromise is exactly what UpgradePanel's own
  // COPY.historyLimit contradicts a few clicks later (old posts stay under
  // Lumen's account on other Hive front ends). Dropped the claim here rather
  // than repeat it and then walk it back.
  description: 'Turn your Lumen account into a full Hive account with your own keys and your own name on chain.'
};

/**
 * The upgrade entry point. `/api/account/upgrade` and the whole upgrade service
 * existed with nothing anywhere linking to them — this page is that missing door.
 */
export default function UpgradePage() {
  // ★ NO SHELL ON THIS ROUTE — see app/security/page.tsx for why the landmark
  // lives here rather than in the root layout.
  return (
    <main>
      <UpgradePanel />
    </main>
  );
}
