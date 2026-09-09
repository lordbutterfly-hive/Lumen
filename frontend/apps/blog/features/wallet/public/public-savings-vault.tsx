'use client';

import Big from 'big.js';
import type { GetDynamicGlobalPropertiesResponse } from '@hiveio/wax';
import { useTranslation } from '@/blog/i18n/client';
import { formatTokenAmount } from '@/blog/features/wallet/lib/format-amount';
import PublicSavingsSlot from './public-savings-slot';

function formatLastPayment(iso: string, locale: string): string | null {
  const date = new Date(`${iso}Z`);
  // Hive uses 1970-01-01T00:00:00 as "never paid yet" for accounts with no
  // savings interest history.
  if (date.getUTCFullYear() <= 1970) return null;
  return date.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Read-only copy of features/wallet/components/savings-vault.tsx for the
 * public wallet page. Removed: SavingsDepositDialog, SavingsWithdrawDialog,
 * useClaimNow and its Claim now button and toast. A visitor cannot move
 * money into or out of someone else's savings, and the accrued interest
 * below is now stated as plain text rather than offered as a button to
 * press.
 */
export default function PublicSavingsVault({
  savingsHive,
  savingsHbd,
  rewardHbd,
  savingsHbdLastInterestPayment,
  dynamicGlobal
}: {
  savingsHive: Big;
  savingsHbd: Big;
  rewardHbd: Big;
  savingsHbdLastInterestPayment: string;
  dynamicGlobal: GetDynamicGlobalPropertiesResponse | null;
}) {
  const { t, i18n } = useTranslation('common_blog');

  const hbdApr = dynamicGlobal ? dynamicGlobal.hbd_interest_rate / 100 : 0;
  const lastPayment = formatLastPayment(savingsHbdLastInterestPayment, i18n.resolvedLanguage ?? 'en');

  return (
    <section id="public-savings-vault">
      <div className="mb-4 mt-6 flex items-center gap-3.5">
        <span className="text-label font-medium uppercase tracking-label text-ink-14">
          {t('wallet.savings.label')}
        </span>
        <div className="h-px flex-1 bg-surface-27" />
      </div>

      <div className="mb-[18px] rounded-panel border border-line-9 bg-surface-1 p-5">
        <div className="mb-4 flex items-start gap-3.5">
          <span
            className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-xl bg-surface-info-9"
            aria-hidden
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <circle cx="11" cy="12" r="3.4" />
              <path d="M11 12h3.5" />
              <path d="M11 8.6v.001M14.4 12v.001M11 15.4v.001M7.6 12v.001M18 9v6" />
            </svg>
          </span>
          <div>
            <div className="text-[16px] leading-[24px] font-semibold text-ink-2">{t('wallet.savings.heading')}</div>
            <p className="mt-0.5 font-ui text-caption text-ink-10">{t('wallet.public.savings_description')}</p>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <PublicSavingsSlot
            testId="public-hive-savings"
            currency="HIVE"
            title={t('wallet.savings.hive_title')}
            chip={t('wallet.savings.hive_no_interest_badge')}
            chipTone="neutral"
            balance={savingsHive}
          />
          <PublicSavingsSlot
            testId="public-hbd-savings"
            currency="HBD"
            title={t('wallet.savings.hbd_title')}
            chip={t('wallet.savings.hbd_apr_badge', { apr: hbdApr.toFixed(2) })}
            chipTone="green"
            description={
              lastPayment
                ? t('wallet.public.savings_hbd_description', { date: lastPayment })
                : t('wallet.public.savings_hbd_description_never')
            }
            balance={savingsHbd}
            accrued={rewardHbd.gt(0) ? t('wallet.savings.claimable', { amount: formatTokenAmount(rewardHbd) }) : null}
          />
        </div>
      </div>
    </section>
  );
}
