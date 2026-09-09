'use client';

import { useTranslation } from '@/blog/i18n/client';
import { WalletFigures } from '@/blog/features/wallet/lib/wallet-derived';
import { formatTokenAmount } from '@/blog/features/wallet/lib/format-amount';
import TokenIcon from '@/blog/features/wallet/components/token-icon';
import PublicStakedHiveBlock from './public-staked-hive-block';

const CARD_CLASS = 'mb-3 rounded-panel border border-line-9 bg-surface-1 p-5';

/**
 * Read-only copy of features/wallet/components/hive-token-card.tsx for the
 * public wallet page. Removed: SendDialog and its Send button. Nobody can
 * send from someone else's HIVE balance from this page.
 */
export default function PublicHiveTokenCard({
  username,
  figures
}: {
  username: string;
  figures: WalletFigures;
}) {
  const { t } = useTranslation('common_blog');

  return (
    <div className={CARD_CLASS} data-testid="public-hive-card">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="flex items-center gap-3.5">
          <TokenIcon currency="HIVE" />
          <div>
            <div className="text-[16px] leading-[24px] font-semibold text-ink-2">{t('wallet.hive_card.name')}</div>
            <div className="text-[14px] leading-[22px] text-ink-10">{t('wallet.hive_card.description')}</div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2.5">
          <span
            className="font-num font-semibold text-[22px] leading-[30px] text-ink-2"
            data-testid="public-hive-balance"
          >
            {formatTokenAmount(figures.liquidHive)}
          </span>
        </div>
      </div>

      <PublicStakedHiveBlock username={username} figures={figures} />
    </div>
  );
}
