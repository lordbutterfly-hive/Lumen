'use client';

import { useTranslation } from '@/blog/i18n/client';
import { formatHpCompact } from '../lib/proposals-format';

/** Right-rail card explaining + showing the real #0 Return Proposal vote threshold. */
export default function ReturnThresholdCard({ thresholdHp }: { thresholdHp: number | undefined }) {
  const { t } = useTranslation('common_blog');

  return (
    <div className="rounded-[18px] border border-[#ebebeb] bg-white p-5" data-testid="return-threshold-card">
      <div className="mb-1.5 font-sans text-[14.5px] font-bold text-[#161511]">
        {t('proposals.return_card.title')}
      </div>
      <p className="mb-3.5 font-serif text-[12.5px] leading-normal text-[#6b7280]">
        {t('proposals.return_card.description')}
      </p>
      <div className="flex items-center justify-between rounded-[11px] border border-dashed border-[#d5d8dd] p-[12px_14px] font-sans text-[13px]">
        <span className="font-semibold text-[#3f4650]">{t('proposals.return_card.label')}</span>
        <span className="tabular-nums font-bold text-[#c0392b]" data-testid="return-threshold-value">
          {thresholdHp === undefined ? t('global.loading') : formatHpCompact(thresholdHp)}
        </span>
      </div>
    </div>
  );
}
