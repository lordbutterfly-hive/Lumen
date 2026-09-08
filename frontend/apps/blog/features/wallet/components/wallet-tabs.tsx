'use client';

/**
 * The wallet's three in-page tabs: Hive, Magi, Meritum (owner ruling 2026-09-08).
 *
 * ★ CONTROLLED BY THE SHELL. `WalletShell` owns the active tab so it can gate
 * the right rail (the Hive-only Advanced Tools card) to the Hive tab; this
 * component renders the bar and the panels for whatever tab it is handed and
 * reports a click back up.
 *
 * ★ THE HIVE TAB IS THE EXISTING WALLET, UNTOUCHED. `WalletContent` is rendered
 * exactly as `WalletShell` rendered it before; its markup, data flow and
 * identity/tier gating are not changed by this file, and any change to it is a
 * regression. The masthead stays inside the panel, where `WalletContent` has
 * always drawn it.
 *
 * ★ PANELS MOUNT ONLY WHILE ACTIVE (Radix Tabs' default). A reader who lands on
 * the Hive tab pays none of the Magi or Meritum reads until they open those
 * tabs. The React Query cache and the SSR-seed provider both live ABOVE this
 * component (in app/layout.tsx and app/wallet/page.tsx), so switching away and
 * back keeps the Hive panel's no-flash first paint (use-wallet-account.ts:37-71).
 *
 * The bar is the same tab treatment `/wallet/tokens` shipped with
 * (your-tokens-view.tsx:429-454): warm track, lit active pill, inline glow (a
 * `/` inside a Tailwind arbitrary value is the opacity shorthand, so the glow
 * cannot be a class).
 */
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@ui/components/tabs';
import { useTranslation } from '@/blog/i18n/client';
import { WALLET_TABS, parseWalletTab, type WalletTab } from '../lib/wallet-tab';
import WalletContent from './wallet-content';
import MagiPanel from './magi/magi-panel';
import MeritumPanel from './meritum/meritum-panel';

const ACTIVE_GLOW = { boxShadow: 'var(--lift-1), 0 0 12px -5px rgb(var(--lum) / 0.85)' } as const;

export default function WalletTabs({ tab, onTabChange }: { tab: WalletTab; onTabChange: (tab: WalletTab) => void }) {
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
        data-testid="wallet-tabs"
      >
        {WALLET_TABS.map((value) => (
          <TabsTrigger
            key={value}
            value={value}
            style={tab === value ? ACTIVE_GLOW : undefined}
            className="rounded-lg px-[18px] py-2 font-ui text-[14px] leading-[22px] font-medium text-ink-10 shadow-none data-[state=active]:bg-[var(--lum-1)] data-[state=active]:text-ink-2"
            data-testid={`wallet-tab-${value}`}
          >
            {t(`wallet.tabs.${value}`)}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="hive" className="mt-0 outline-none" data-testid="wallet-panel-hive">
        <WalletContent />
      </TabsContent>
      <TabsContent value="magi" className="mt-0 outline-none" data-testid="wallet-panel-magi">
        <MagiPanel />
      </TabsContent>
      <TabsContent value="meritum" className="mt-0 outline-none" data-testid="wallet-panel-meritum">
        <MeritumPanel />
      </TabsContent>
    </Tabs>
  );
}
