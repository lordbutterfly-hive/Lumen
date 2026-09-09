'use client';

import Big from 'big.js';
import { useTranslation } from '@/blog/i18n/client';
import { formatTokenAmount } from '@/blog/features/wallet/lib/format-amount';
import TokenIcon from '@/blog/features/wallet/components/token-icon';

const CARD_CLASS = 'mb-3 rounded-panel border border-line-9 bg-surface-1 p-5';

/**
 * Read-only copy of features/wallet/components/hbd-token-card.tsx for the
 * public wallet page. Removed: SendDialog and its Send button, and the
 * username prop that only existed to feed it.
 */
export default function PublicHbdTokenCard({ liquidHbd }: { liquidHbd: Big }) {
  const { t } = useTranslation('common_blog');

  return (
    <div className={CARD_CLASS} data-testid="public-hbd-card">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="flex items-center gap-3.5">
          <TokenIcon currency="HBD" />
          <div>
            <div className="text-[16px] leading-[24px] font-semibold text-ink-2">{t('wallet.hbd_card.name')}</div>
            <div className="text-[14px] leading-[22px] text-ink-10">{t('wallet.hbd_card.description')}</div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2.5">
          <span
            className="font-num font-semibold text-[22px] leading-[30px] text-ink-2"
            data-testid="public-hbd-balance"
          >
            {formatTokenAmount(liquidHbd)}
          </span>
        </div>
      </div>
    </div>
  );
}
