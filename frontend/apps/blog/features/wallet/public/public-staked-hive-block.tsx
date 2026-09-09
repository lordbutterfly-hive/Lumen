'use client';

import { Icons } from '@ui/components/icons';
import { useTranslation } from '@/blog/i18n/client';
import { WalletFigures } from '@/blog/features/wallet/lib/wallet-derived';
import { formatTokenAmount } from '@/blog/features/wallet/lib/format-amount';
import PublicDelegatedOutPanel from './public-delegated-out-panel';

/**
 * Read-only copy of features/wallet/components/staked-hive-block.tsx for the
 * public wallet page. Removed: PowerUpDialog, PowerDownDialog and
 * StopPowerDownAlert, along with their Stake, Unstake and STOP buttons.
 * Nobody can move stake on this account from a page that is not theirs. The
 * power down schedule text stays: it states public chain state that anyone
 * can already see, it is not an action.
 */
export default function PublicStakedHiveBlock({
  username,
  figures
}: {
  username: string;
  figures: WalletFigures;
}) {
  const { t } = useTranslation('common_blog');
  const { vestingHp, netHp, delegatedOutHp, hpApr, powerDown } = figures;

  return (
    <div className="mt-4 flex flex-col gap-4 border-l-2 border-line-2 pl-4">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-4">
        <div className="max-w-[520px]">
          <div className="mb-1 flex items-center gap-2">
            <span className="text-[16px] leading-[24px] font-semibold text-ink-4">{t('wallet.staked.title')}</span>
            <span className="rounded-control bg-surface-23 px-2 py-[2px] text-caption font-medium text-ink-8">
              {t('wallet.staked.badge')}
            </span>
            <span className="rounded-control bg-surface-ok-5 px-2 py-[2px] text-caption font-medium tabular-nums text-ink-ok-2">
              {t('wallet.staked.apr', { apr: hpApr.toFixed(2) })}
            </span>
          </div>
          <p className="font-ui text-[14px] leading-[22px] text-ink-10">{t('wallet.staked.description')}</p>

          {powerDown.isActive ? (
            <div
              className="mt-2.5 flex items-center gap-2.5 rounded-card border border-line-warn-2 bg-surface-warn-3 px-3 py-2.5 text-caption text-ink-warn-2"
              data-testid="public-hp-schedule-notice"
            >
              <Icons.warning className="h-[15px] w-[15px] shrink-0 text-ink-warn-7" />
              <span className="flex-1 tabular-nums">
                {t('wallet.staked.power_down_notice', {
                  days: powerDown.daysUntilNext,
                  amount: powerDown.nextPaymentHp.toFixed(3),
                  weeks: powerDown.weeksLeft
                })}
              </span>
            </div>
          ) : null}
        </div>

        <div className="flex flex-col items-end gap-2.5">
          <div className="text-right">
            <div
              className="font-num font-semibold text-[22px] leading-[30px] text-ink-2"
              data-testid="public-hp-balance"
            >
              {formatTokenAmount(vestingHp)}
            </div>
            <div className="text-caption tabular-nums text-ink-14" data-testid="public-hp-effective">
              {t('profile.stats.hp_effective', { value: formatTokenAmount(netHp) })}
            </div>
          </div>
        </div>
      </div>

      <PublicDelegatedOutPanel username={username} delegatedOutHp={delegatedOutHp} />
    </div>
  );
}
