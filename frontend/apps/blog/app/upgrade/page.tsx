import { Metadata } from 'next';
import UpgradePanel from '@/blog/features/lite-auth/upgrade/upgrade-panel';

export const metadata: Metadata = {
  title: 'Upgrade to a full Hive account',
  description:
    'Turn your Lumen account into a full Hive account with your own keys, keeping your posting history.'
};

/**
 * The upgrade entry point. `/api/account/upgrade` and the whole upgrade service
 * existed with nothing anywhere linking to them — this page is that missing door.
 */
export default function UpgradePage() {
  return <UpgradePanel />;
}
