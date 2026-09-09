'use client';

/**
 * Read-only copy of features/wallet/components/magi/magi-panel.tsx, narrowed
 * to one account named by the URL instead of every account a signed-in
 * reader holds under.
 *
 * WHAT WAS REMOVED AND WHY. No useUserClient/session check (this page never
 * asks "who is looking", D5), no wallet-identity fan-out (there is exactly
 * one account here: the Hive name in the URL, so no per-account map/list),
 * no Deposit, Send or Withdraw controls (S1: zero signing surface on a page
 * that shows someone else's money), and no MagiSdkSwap (a swap widget is a
 * signing surface too). A lite target never resolves its bound wallet DIDs
 * (D4), so it shows a notice instead of a card, with the read hook disabled.
 */

import { useTranslation } from '@/blog/i18n/client';
import PageMasthead from '@/blog/features/layouts/page-masthead';
import { useHiveMarketPrices } from '@/blog/features/wallet/hooks/use-hive-market-prices';
import { usePublicMagiAssets } from './hooks/use-public-magi-assets';
import PublicMagiAccountCard from './public-magi-account-card';

const Notice = ({ children, testId }: { children: React.ReactNode; testId: string }) => (
  <div className="rounded-card border border-dashed border-line-11 px-5 py-6 text-center font-ui text-[14px] leading-[22px] text-ink-14" data-testid={testId}>
    {children}
  </div>
);

export default function PublicMagiPanel({ username, target }: { username: string; target: 'hive' | 'lite' }) {
  const { t } = useTranslation('common_blog');
  const magi = usePublicMagiAssets(username, target === 'hive');
  const { data: prices } = useHiveMarketPrices();

  return (
    <div data-testid="public-wallet-magi">
      <PageMasthead title={t('wallet.tabs.magi')}>
        <p className="max-w-[620px] font-ui text-caption text-ink-10">{t('wallet.public.magi_masthead_meta')}</p>
      </PageMasthead>

      {target === 'lite' ? (
        <Notice testId="public-wallet-magi-lite">{t('wallet.public.lite_magi')}</Notice>
      ) : magi.unavailable ? (
        <Notice testId="public-wallet-magi-unavailable">{t('wallet.magi.unavailable')}</Notice>
      ) : (
        <PublicMagiAccountCard
          username={username}
          assets={magi.assets}
          assetsLoading={magi.assetsLoading}
          assetsFailed={magi.assetsFailed}
          btcSats={magi.btcSats}
          btcLoading={magi.btcLoading}
          btcFailed={magi.btcFailed}
          btcUnavailable={magi.btcUnavailable}
          prices={prices ?? null}
        />
      )}
    </div>
  );
}
