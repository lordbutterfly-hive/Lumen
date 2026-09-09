'use client';

import { useTranslation } from '@/blog/i18n/client';
import PageMasthead from '@/blog/features/layouts/page-masthead';
import { useWalletAccount } from '@/blog/features/wallet/hooks/use-wallet-account';
import { useAccountHistory } from '@/blog/features/wallet/hooks/use-account-history';
import { useDelegations } from '@/blog/features/wallet/hooks/use-delegations';
import PublicEstimatedValueStrip from './public-estimated-value-strip';
import PublicAccountHistoryList from './public-account-history-list';
import PublicHiveTokenCard from './public-hive-token-card';
import PublicHbdTokenCard from './public-hbd-token-card';
import PublicSavingsVault from './public-savings-vault';

const READONLY_BADGE_CLASS = 'rounded-control bg-surface-23 px-2 py-[2px] text-caption font-medium text-ink-8';

/**
 * Read-only copy of features/wallet/components/wallet-content.tsx's Hive
 * branch, for the public /@name/wallet page. Removed: every dialog and
 * mutation (Send, Power Up, Power Down, Delegate, Savings Deposit, Savings
 * Withdraw, Claim now), the session and tier reads (useSessionIdentity,
 * useServerAccountTier, useUserClient, useTokenAccounts) and the logged out
 * branch. Identity here comes from the URL, resolved on the server before
 * this ever mounts (D5), so there is no login state to render. The masthead
 * now renders once above every branch instead of once per branch, since a
 * public visitor should always see whose wallet this is, even while it is
 * still loading or failed to load.
 */
export default function PublicHivePanel({
  username,
  target
}: {
  username: string;
  target: 'hive' | 'lite';
}) {
  const { t, i18n } = useTranslation('common_blog');

  const { account, figures, dynamicGlobal, isError, error } = useWalletAccount(target === 'lite' ? '' : username);

  // Warmed unconditionally, same as wallet-content.tsx: neither depends on
  // the balance summary, so there is no reason to wait for it. '' for lite
  // keeps both queries disabled (enabled: !!username in both hooks).
  const historyLang = i18n.resolvedLanguage ?? 'en';
  const historyUsername = target === 'lite' ? '' : username;
  useAccountHistory(historyUsername, historyLang);
  useDelegations(historyUsername);

  const masthead = (
    <PageMasthead
      title={t('wallet.public.title', { username })}
      actions={
        <span className={READONLY_BADGE_CLASS} data-testid="public-wallet-readonly-badge">
          {t('wallet.public.readonly_badge')}
        </span>
      }
    >
      <p className="max-w-[620px] font-ui text-caption text-ink-10">{t('wallet.public.masthead_meta')}</p>
    </PageMasthead>
  );

  if (target === 'lite') {
    return (
      <div data-testid="public-wallet-lite">
        {masthead}
        <p className="text-caption text-ink-10" data-testid="public-wallet-lite-notice">
          {t('wallet.public.lite_hive')}
        </p>
      </div>
    );
  }

  if (isError) {
    return (
      <div data-testid="public-wallet-error">
        {masthead}
        <p className="text-caption text-destructive" data-testid="public-wallet-error-copy">
          {error?.accountNotFound
            ? t('wallet.errors.account_not_found', { chain: error.chain ?? 'this chain' })
            : t('wallet.public.summary_failed')}
        </p>
      </div>
    );
  }

  // Gate on data presence, not isLoading, same as wallet-content.tsx: React
  // Query v4 reports isLoading:true even while the seeded initialData is
  // already present.
  if (!account || !figures) {
    return (
      <div data-testid="public-wallet-loading">
        {masthead}
        <p className="text-caption text-ink-10" data-testid="public-wallet-loading-copy">
          {t('wallet.loading')}
        </p>
      </div>
    );
  }

  return (
    <div data-testid="public-wallet-hive">
      {masthead}

      <PublicHiveTokenCard username={username} figures={figures} />
      <PublicHbdTokenCard liquidHbd={figures.liquidHbd} />

      <PublicSavingsVault
        savingsHive={figures.savingsHive}
        savingsHbd={figures.savingsHbd}
        rewardHbd={figures.rewardHbd}
        savingsHbdLastInterestPayment={account.savings_hbd_last_interest_payment}
        dynamicGlobal={dynamicGlobal}
      />

      <PublicEstimatedValueStrip figures={figures} />

      <PublicAccountHistoryList username={username} />
    </div>
  );
}
