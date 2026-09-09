'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import LeftRail from '@/blog/features/layouts/left-rail';
import { defaultWalletTab, parseWalletTab, type WalletTab } from '@/blog/features/wallet/lib/wallet-tab';
import PublicWalletTabs from './public-wallet-tabs';
import PublicWalletRightRail from './public-wallet-right-rail';

/**
 * Read-only copy of features/wallet/components/wallet-shell.tsx for the
 * public /@name/wallet page. Same fixed three column grid, the same
 * LeftRail, and the same pushState plus useSearchParams tab URL sync, copied
 * rather than shared per D2 (the private wallet tree is never edited). This
 * shell takes username and target as props so its panels know whose wallet,
 * and what kind of account, they are showing, since a public visitor has no
 * session to read that from.
 */
export default function PublicWalletShell({
  username,
  target,
  initialTab
}: {
  username: string;
  target: 'hive' | 'lite';
  initialTab: WalletTab;
}) {
  const [tab, setTab] = useState<WalletTab>(initialTab);
  // The tab a bare URL (no `?tab=`) means for THIS target: Magi for a lite
  // account, Hive otherwise (the server picks the same default, D13). The
  // private shell hard-codes 'hive' here, which flips a lite reader from the
  // server-chosen Magi tab back to Hive on hydration; this copy keys both the
  // URL writer and the URL reader on the same fallback so they agree.
  const fallbackTab = defaultWalletTab(target === 'lite' ? 'lite' : 'full');
  const searchParams = useSearchParams();

  const onTabChange = useCallback((next: WalletTab) => {
    setTab(next);
    try {
      const url = new URL(window.location.href);
      if (next === fallbackTab) url.searchParams.delete('tab');
      else url.searchParams.set('tab', next);
      if (url.toString() !== window.location.href) {
        window.history.pushState(window.history.state, '', url.toString());
      }
    } catch {
      /* URL update is a convenience; the tab already switched */
    }
  }, [fallbackTab]);

  useEffect(() => {
    const fromUrl = parseWalletTab(searchParams?.get('tab')) ?? fallbackTab;
    setTab((current) => (current === fromUrl ? current : fromUrl));
  }, [searchParams, fallbackTab]);

  const showRightRail = tab === 'hive';

  return (
    <div
      className={`font-ui relative mx-auto grid max-w-[1720px] grid-cols-1 gap-11 px-6 pb-20 pt-[26px] md:grid-cols-[200px_minmax(0,1fr)] md:px-11 ${
        showRightRail ? 'xl:grid-cols-[200px_minmax(0,1fr)_312px]' : ''
      }`}
      data-testid="public-wallet-shell"
    >
      <div
        className="pointer-events-none absolute bottom-20 left-[244px] top-[26px] hidden w-px bg-surface-26 md:block"
        aria-hidden
      />

      <aside className="sticky top-24 hidden h-fit bg-background-secondary md:block">
        <LeftRail />
      </aside>

      <main className="min-w-0">
        <PublicWalletTabs username={username} target={target} tab={tab} onTabChange={onTabChange} />
      </main>

      {showRightRail ? (
        <aside className="sticky top-24 hidden h-fit bg-background-secondary xl:block">
          <PublicWalletRightRail />
        </aside>
      ) : null}
    </div>
  );
}
