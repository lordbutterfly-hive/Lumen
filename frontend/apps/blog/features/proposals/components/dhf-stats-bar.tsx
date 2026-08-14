'use client';

import { Skeleton } from '@hive/ui';
import { useTranslation } from '@/blog/i18n/client';
import { formatHbd } from '../lib/proposals-format';
import { DhfStats } from '../lib/proposals-types';

/** Daily funded / HBD stabilizer / max daily budget / total budget — all real chain data. */
export default function DhfStatsBar({ stats }: { stats: DhfStats | undefined }) {
  const { t } = useTranslation('common_blog');

  if (!stats) {
    return (
      <div
        className="my-5 flex flex-wrap gap-6 rounded-2xl border border-line-9 bg-surface-5 p-[16px_22px] font-sans text-[14px] leading-[22px] text-ink-10"
        data-testid="dhf-stats-bar-loading"
      >
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-4 w-32" />
        ))}
      </div>
    );
  }

  return (
    <div
      className="my-5 flex flex-wrap gap-6 rounded-2xl border border-line-9 bg-surface-5 p-[16px_22px] font-sans text-[14px] leading-[22px] text-ink-10"
      data-testid="dhf-stats-bar"
    >
      <span>
        {t('proposals.stats.daily_funded')}{' '}
        <strong className="tabular-nums text-ink-ok-2">{formatHbd(stats.dailyFundedHbd)}</strong>
      </span>
      <span>
        {t('proposals.stats.hbd_stabilizer')}{' '}
        <strong className="tabular-nums text-ink-brand-6" data-testid="dhf-stats-stabilizer">
          {stats.hbdStabilizerHbd === null ? t('global.loading') : formatHbd(stats.hbdStabilizerHbd)}
        </strong>
      </span>
      <span>
        {t('proposals.stats.max_daily_budget')}{' '}
        <strong className="tabular-nums text-ink-2">{formatHbd(stats.maxDailyBudgetHbd)}</strong>
      </span>
      <span>
        {t('proposals.stats.total_budget')}{' '}
        <strong className="tabular-nums text-ink-2">{formatHbd(stats.totalBudgetHbd)}</strong>
      </span>
    </div>
  );
}
