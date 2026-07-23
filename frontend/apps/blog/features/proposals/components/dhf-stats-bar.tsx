'use client';

import { useTranslation } from '@/blog/i18n/client';
import { formatHbd } from '../lib/proposals-format';
import { DhfStats } from '../lib/proposals-types';

/** Daily funded / HBD stabilizer / max daily budget / total budget — all real chain data. */
export default function DhfStatsBar({ stats }: { stats: DhfStats }) {
  const { t } = useTranslation('common_blog');

  return (
    <div
      className="my-5 flex flex-wrap gap-6 rounded-2xl border border-[#ebebeb] bg-[#fbfbfa] p-[16px_22px] font-sans text-[13.5px] text-[#6b7280]"
      data-testid="dhf-stats-bar"
    >
      <span>
        {t('proposals.stats.daily_funded')}{' '}
        <strong className="tabular-nums text-[#2f7d4f]">{formatHbd(stats.dailyFundedHbd)}</strong>
      </span>
      <span>
        {t('proposals.stats.hbd_stabilizer')}{' '}
        <strong className="tabular-nums text-[#c0392b]" data-testid="dhf-stats-stabilizer">
          {stats.hbdStabilizerHbd === null ? '—' : formatHbd(stats.hbdStabilizerHbd)}
        </strong>
      </span>
      <span>
        {t('proposals.stats.max_daily_budget')}{' '}
        <strong className="tabular-nums text-[#161511]">{formatHbd(stats.maxDailyBudgetHbd)}</strong>
      </span>
      <span>
        {t('proposals.stats.total_budget')}{' '}
        <strong className="tabular-nums text-[#161511]">{formatHbd(stats.totalBudgetHbd)}</strong>
      </span>
    </div>
  );
}
