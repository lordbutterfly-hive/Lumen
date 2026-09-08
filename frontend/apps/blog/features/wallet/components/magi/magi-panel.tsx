'use client';

/**
 * The wallet's Magi tab: everything the reader holds on Magi, one card per Magi
 * account (a Hive account, and/or each bound wallet, never merged), with the
 * deposit and swap controls in the card header.
 *
 * Account states mirror the tokens page's, on purpose (your-tokens-view.tsx:
 * 317-371): unavailable build, session check failed, wallet lookup failed,
 * wallet lookup still running, Google-only (cannot hold), and the real thing.
 * Each says what it is; none renders an empty balance as a fact.
 */
import { Link } from '@hive/ui';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useTranslation } from '@/blog/i18n/client';
import PageMasthead from '@/blog/features/layouts/page-masthead';
import { displayHandle } from '@/blog/features/creator-tokens/live/adapt';
import { useMagiAssets } from '../../hooks/use-magi-assets';
import { useHiveMarketPrices } from '../../hooks/use-hive-market-prices';
import MagiAccountCard from './magi-account-card';

const SECONDARY_BUTTON_CLASS =
  'lm-press rounded-card border border-line-11 px-4 py-2 text-caption font-medium text-ink-7 transition-colors hover:bg-surface-16';

const Notice = ({ children, testId }: { children: React.ReactNode; testId: string }) => (
  <div className="rounded-card border border-dashed border-line-11 px-5 py-6 text-center font-ui text-[14px] leading-[22px] text-ink-14" data-testid={testId}>
    {children}
  </div>
);

export default function MagiPanel() {
  const { t } = useTranslation('common_blog');
  const { retrySession, sessionUnavailable } = useUserClient();
  const magi = useMagiAssets();
  const { data: prices } = useHiveMarketPrices();

  return (
    <div data-testid="wallet-magi-content">
      <PageMasthead title={t('wallet.tabs.magi')}>
        <p className="max-w-[620px] font-ui text-caption text-ink-10">{t('wallet.magi.masthead_meta')}</p>
      </PageMasthead>

      {magi.unavailable ? (
        <Notice testId="wallet-magi-unavailable">{t('wallet.magi.unavailable')}</Notice>
      ) : magi.accountsFailed && sessionUnavailable ? (
        <Notice testId="wallet-magi-session-failed">
          {t('wallet.magi.session_failed')}{' '}
          <button type="button" onClick={retrySession} className="font-medium text-ink-brand-6 underline">
            {t('wallet.magi.try_again')}
          </button>
        </Notice>
      ) : magi.accountsFailed ? (
        <Notice testId="wallet-magi-accounts-failed">{t('wallet.magi.accounts_failed')}</Notice>
      ) : magi.accountsLoading ? (
        <Notice testId="wallet-magi-accounts-loading">{t('wallet.magi.accounts_loading')}</Notice>
      ) : magi.accounts.length === 0 ? (
        // Only a Google-only lite account lands here: no keypair, so Magi has no
        // account to key a balance to. Both ways out are real routes
        // (meritum-eligibility.tsx:167-169).
        <div className="rounded-panel border border-line-9 bg-surface-1 p-5" data-testid="wallet-magi-no-account">
          <div className="text-[16px] leading-[24px] font-semibold text-ink-2">{t('wallet.magi.no_account_title')}</div>
          <p className="mt-1 max-w-[620px] font-ui text-caption text-ink-10">{t('wallet.magi.no_account_body')}</p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Link href="/security" className={SECONDARY_BUTTON_CLASS}>
              {t('wallet.magi.no_account_link_wallet')}
            </Link>
            <Link href="/upgrade" className={SECONDARY_BUTTON_CLASS}>
              {t('wallet.lite_upgrade')}
            </Link>
          </div>
        </div>
      ) : (
        magi.accounts.map((entry) => (
          <MagiAccountCard
            key={entry.account.id}
            entry={entry}
            prices={prices ?? null}
            btcUnavailable={magi.btcUnavailable}
            ownLabel={
              entry.account.kind === 'hive'
                ? t('wallet.magi.account_hive', { name: displayHandle(entry.account.id) })
                : entry.account.kind === 'evm'
                  ? t('wallet.magi.account_evm')
                  : t('wallet.magi.account_btc')
            }
          />
        ))
      )}
    </div>
  );
}
