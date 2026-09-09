'use client';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@ui/components/tabs';
import { useTranslation } from '@/blog/i18n/client';
import { WALLET_TABS, parseWalletTab, type WalletTab } from '@/blog/features/wallet/lib/wallet-tab';
import PublicHivePanel from './public-hive-panel';
import PublicMagiPanel from './public-magi-panel';
import PublicMeritumPanel from './public-meritum-panel';

const ACTIVE_GLOW = { boxShadow: 'var(--lift-1), 0 0 12px -5px rgb(var(--lum) / 0.85)' } as const;

/**
 * Read-only copy of features/wallet/components/wallet-tabs.tsx for the
 * public wallet page. Same Radix Tabs treatment, the same three tabs and the
 * same active glow, copied per D2. Removed: WalletContent, MagiPanel and
 * MeritumPanel are replaced with their Public counterparts, which take an
 * explicit username and target instead of reading the signed in session,
 * since a public visitor has none.
 */
export default function PublicWalletTabs({
  username,
  target,
  tab,
  onTabChange
}: {
  username: string;
  target: 'hive' | 'lite';
  tab: WalletTab;
  onTabChange: (tab: WalletTab) => void;
}) {
  const { t } = useTranslation('common_blog');

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => {
        const next = parseWalletTab(value);
        if (next) onTabChange(next);
      }}
    >
      <TabsList
        aria-label={t('wallet.tabs.label')}
        className="mb-5 inline-flex h-auto items-center gap-1.5 rounded-xl border border-line-6 bg-[var(--amb-1)] p-[5px] text-ink-10"
        data-testid="public-wallet-tabs"
      >
        {WALLET_TABS.map((value) => (
          <TabsTrigger
            key={value}
            value={value}
            style={tab === value ? ACTIVE_GLOW : undefined}
            className="rounded-lg px-[18px] py-2 font-ui text-[14px] leading-[22px] font-medium text-ink-10 shadow-none data-[state=active]:bg-[var(--lum-1)] data-[state=active]:text-ink-2"
            data-testid={`public-wallet-tab-${value}`}
          >
            {t(`wallet.tabs.${value}`)}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="hive" className="mt-0 outline-none" data-testid="public-wallet-panel-hive">
        <PublicHivePanel username={username} target={target} />
      </TabsContent>
      <TabsContent value="magi" className="mt-0 outline-none" data-testid="public-wallet-panel-magi">
        <PublicMagiPanel username={username} target={target} />
      </TabsContent>
      <TabsContent value="meritum" className="mt-0 outline-none" data-testid="public-wallet-panel-meritum">
        <PublicMeritumPanel username={username} target={target} />
      </TabsContent>
    </Tabs>
  );
}
