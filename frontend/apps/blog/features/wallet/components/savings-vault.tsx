'use client';

import Big from 'big.js';
import { GetDynamicGlobalPropertiesResponse } from '@hiveio/wax';
import { toast } from '@ui/components/hooks/use-toast';
import { handleError } from '@ui/lib/handle-error';
import { useTranslation } from '@/blog/i18n/client';
import { useClaimNow } from '../hooks/use-claim-now';
import { formatTokenAmount } from '../lib/format-amount';
import SavingsSlotCard from './savings-slot-card';

function formatLastPayment(iso: string, locale: string): string | null {
  const date = new Date(`${iso}Z`);
  // Hive uses 1970-01-01T00:00:00 as "never paid yet" for accounts with no
  // savings interest history.
  if (date.getUTCFullYear() <= 1970) return null;
  return date.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function SavingsVault({
  username,
  savingsHive,
  savingsHbd,
  liquidHive,
  liquidHbd,
  rewardHbd,
  hasClaimableRewards,
  savingsHbdLastInterestPayment,
  dynamicGlobal
}: {
  username: string;
  savingsHive: Big;
  savingsHbd: Big;
  liquidHive: Big;
  liquidHbd: Big;
  rewardHbd: Big;
  hasClaimableRewards: boolean;
  savingsHbdLastInterestPayment: string;
  dynamicGlobal: GetDynamicGlobalPropertiesResponse | null;
}) {
  const { t, i18n } = useTranslation('common_blog');
  const { claim, isPending: isClaiming } = useClaimNow(username);

  const hbdApr = dynamicGlobal ? dynamicGlobal.hbd_interest_rate / 100 : 0;
  const lastPayment = formatLastPayment(savingsHbdLastInterestPayment, i18n.resolvedLanguage ?? 'en');

  const handleClaim = async () => {
    try {
      await claim();
      toast({ title: t('wallet.dialogs.common.success_title'), description: t('wallet.savings.claim_now'), variant: 'success' });
    } catch (error) {
      handleError(error, { method: 'walletClaimNow', params: { username } });
    }
  };

  return (
    <section id="savings-vault">
      <div className="mb-4 mt-[34px] flex items-center gap-3.5">
        <span className="text-label font-bold uppercase tracking-[0.09em] text-ink-14">
          {t('wallet.savings.label')}
        </span>
        <div className="h-px flex-1 bg-surface-27" />
      </div>

      <div className="mb-[18px] rounded-panel border-2 border-line-13 bg-gradient-to-b from-surface-13 to-surface-2 p-5">
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
            <div className="text-[20px] font-semibold text-ink-2">{t('wallet.savings.heading')}</div>
            <p className="mt-0.5 font-serif text-caption text-ink-10">{t('wallet.savings.description')}</p>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          {/* ★ W-6: the chip used to read "3-day unlock", which was the same rule
              the panel description states above and the row description stated
              again below. The chip now carries the fact this row does NOT share
              with the HBD row beneath it — that HIVE savings pay no interest —
              which is the exact counterpart of the HBD row's APR chip. */}
          <SavingsSlotCard
            testId="wallet-hive-savings"
            currency="HIVE"
            title={t('wallet.savings.hive_title')}
            chip={t('wallet.savings.hive_no_interest_badge')}
            chipTone="neutral"
            balance={savingsHive}
            username={username}
            liquidBalance={liquidHive}
            depositLabel={t('wallet.savings.deposit')}
            withdrawLabel={t('wallet.savings.withdraw')}
          />
          <SavingsSlotCard
            testId="wallet-hbd-savings"
            currency="HBD"
            title={t('wallet.savings.hbd_title')}
            chip={t('wallet.savings.hbd_apr_badge', { apr: hbdApr.toFixed(2) })}
            chipTone="green"
            description={
              lastPayment
                ? t('wallet.savings.hbd_description', { date: lastPayment })
                : t('wallet.savings.hbd_description_never')
            }
            balance={savingsHbd}
            username={username}
            liquidBalance={liquidHbd}
            depositLabel={t('wallet.savings.deposit')}
            withdrawLabel={t('wallet.savings.withdraw')}
            extraAction={
              // ★ Same wrap fix as savings-slot-card.tsx's own button group
              // (map item 1) — this nested row (claimable text + Claim now)
              // is itself a non-wrapping flex inside that group, and Claim
              // now was the element that landed fully off-screen at 390px.
              <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2.5">
                {rewardHbd.gt(0) ? (
                  <div className="text-right">
                    <div className="text-caption tabular-nums text-ink-14">
                      {t('wallet.savings.claimable', { amount: formatTokenAmount(rewardHbd) })}
                    </div>
                  </div>
                ) : null}
                <button
                  type="button"
                  onClick={handleClaim}
                  disabled={!hasClaimableRewards || isClaiming}
                  className="rounded-card bg-surface-42 px-4 py-2 text-caption font-semibold text-ink-27 transition-colors hover:bg-surface-44 disabled:cursor-not-allowed disabled:opacity-40"
                  data-testid="wallet-claim-now-button"
                >
                  {t('wallet.savings.claim_now')}
                </button>
              </div>
            }
          />
        </div>
      </div>
    </section>
  );
}
