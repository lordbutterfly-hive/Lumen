'use client';

import { useTranslation } from '@/blog/i18n/client';
import { formatHpCompact } from '../lib/proposals-format';

/** Right-rail card explaining + showing the real #0 Return Proposal vote threshold. */
export default function ReturnThresholdCard({ thresholdHp }: { thresholdHp: number | undefined }) {
  const { t } = useTranslation('common_blog');

  return (
    <div className="rounded-panel border border-line-9 bg-surface-1 p-5" data-testid="return-threshold-card">
      <div className="mb-1.5 font-sans text-[15px] leading-[24px] font-bold text-ink-2">
        {t('proposals.return_card.title')}
      </div>
      <p className="mb-3.5 font-serif text-[13px] leading-[20px] text-ink-10">
        {t('proposals.return_card.description')}
      </p>
      <div className="flex items-center justify-between rounded-control border border-dashed border-line-20 p-[12px_14px] font-sans text-[13px] leading-[20px]">
        <span className="font-semibold text-ink-7">{t('proposals.return_card.label')}</span>
        <span className="tabular-nums font-bold text-ink-brand-6" data-testid="return-threshold-value">
          {thresholdHp === undefined ? t('global.loading') : formatHpCompact(thresholdHp)}
        </span>
      </div>
    </div>
  );
}
