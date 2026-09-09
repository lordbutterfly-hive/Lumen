'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import LeftRail from '@/blog/features/layouts/left-rail';
import WalletTabs from './wallet-tabs';
import WalletRightRail from './wallet-right-rail';
import { parseWalletTab, type WalletTab } from '../lib/wallet-tab';

/**
 * Wallet page shell — same fixed 3-column grid as
 * features/discovery-feed/home-shell.tsx (200 / 1fr / 312, gap 44, max-width
 * 1720, symmetric 44px gutters, centered, both rails sticky/locked).
 *
 * ★ TABS (owner ruling 2026-09-08). The centre column is `WalletTabs`: Hive
 * (the existing `WalletContent`, untouched), Magi, Meritum. This shell owns the
 * active tab so it can do the one thing the tab bar cannot: keep the RIGHT RAIL
 * — the Hive price cards and the Hive-only Advanced Tools card (power up/down,
 * delegate, claim account, convert) — on the HIVE TAB ONLY. Those are Hive-
 * account tools; showing them beside the Magi or Meritum panels would be the
 * regression rule #4 guards against. `WalletContent` and `WalletRightRail`
 * themselves are byte-identical to before; only WHERE the rail renders changed.
 *
 * When the rail is hidden (Magi/Meritum) the grid drops its third column, the
 * same `rightRail ? …` idiom `ui/token-shell.tsx` already uses, so the panel
 * gets the full width instead of a 312px gap.
 */
export default function WalletShell({ initialTab, fallbackTab = 'hive' }: { initialTab: WalletTab; fallbackTab?: WalletTab }) {
  const [tab, setTab] = useState<WalletTab>(initialTab);
  // ★ THE BARE URL MEANS THE TIER'S DEFAULT TAB, NOT ALWAYS HIVE (2026-09-09, found
  // by the public wallet's visual pass). `/wallet` with no `?tab=` is Magi for a
  // lite account (app/wallet/page.tsx, `defaultWalletTab`), but this shell hard
  // coded 'hive' as the bare URL tab in both the URL writer and the URL reader
  // below, so the effect flipped a lite reader from the server chosen Magi tab
  // back to Hive on hydration. The page now passes the same default it rendered
  // with, and both sides key on it. A full account still gets 'hive'.
  const searchParams = useSearchParams();

  const onTabChange = useCallback((next: WalletTab) => {
    setTab(next);
    // ★ `pushState`, NOT `replaceState` (tester finding, 2026-09-08): with
    // replaceState the three tabs shared one history entry, so Back left the
    // page instead of stepping back a tab. Both are the NATIVE history API,
    // which Next 14.1+ integrates with the App Router WITHOUT a server round
    // trip (it is `router.push/replace` that would re-run the page and its
    // 600ms seed race); useSearchParams updates on both, and on Back/Forward.
    // Verified empirically on the rebuilt standalone, not assumed: see the
    // build map, section K.
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

  // Back/Forward (and any other URL change) drive the tab from the URL. A
  // click already set the state before pushing the URL, so this is a no-op
  // for clicks and only ever acts on navigation.
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
    >
      <div
        className="pointer-events-none absolute bottom-20 left-[244px] top-[26px] hidden w-px bg-surface-26 md:block"
        aria-hidden
      />

      <aside className="sticky top-24 hidden h-fit bg-background-secondary md:block">
        <LeftRail />
      </aside>

      <main className="min-w-0">
        <WalletTabs tab={tab} onTabChange={onTabChange} />
      </main>

      {showRightRail ? (
        <aside className="sticky top-24 hidden h-fit bg-background-secondary xl:block">
          <WalletRightRail />
        </aside>
      ) : null}
    </div>
  );
}
