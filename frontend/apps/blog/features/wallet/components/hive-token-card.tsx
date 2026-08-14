'use client';

import { GetDynamicGlobalPropertiesResponse } from '@hiveio/wax';
import { useTranslation } from '@/blog/i18n/client';
import { WalletFigures } from '../lib/wallet-derived';
import { formatTokenAmount } from '../lib/format-amount';
import TokenIcon from './token-icon';
import SendDialog from './dialogs/send-dialog';
import StakedHiveBlock from './staked-hive-block';

const CARD_CLASS = 'mb-[18px] rounded-[18px] border border-line-9 bg-surface-1 p-6';
// W-2/W-3: was rounded-[11px] bg-surface-ok-7 — the success green used as an
// action colour, at a radius no other control on the page shared.
const SEND_BUTTON_CLASS =
  'flex items-center gap-1.5 rounded-[14px] bg-surface-brand-12 px-[18px] py-2.5 text-[14px] leading-[22px] font-semibold text-ink-27 transition-colors hover:bg-surface-brand-17';

export default function HiveTokenCard({
  username,
  figures,
  dynamicGlobal
}: {
  username: string;
  figures: WalletFigures;
  dynamicGlobal: GetDynamicGlobalPropertiesResponse | null;
}) {
  const { t } = useTranslation('common_blog');

  return (
    <div className={CARD_CLASS} data-testid="wallet-hive-card">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3.5">
          <TokenIcon currency="HIVE" />
          <div>
            <div className="text-[17px] leading-[26px] font-bold text-ink-2">{t('wallet.hive_card.name')}</div>
            <div className="text-[14px] leading-[22px] text-ink-10">{t('wallet.hive_card.description')}</div>
          </div>
        </div>
        <div className="flex items-center gap-3.5">
          <span
            className="font-sans text-2xl font-bold tabular-nums text-ink-2"
            data-testid="wallet-hive-balance"
          >
            {formatTokenAmount(figures.liquidHive)}
          </span>
          <SendDialog
            currency="HIVE"
            username={username}
            balance={figures.liquidHive}
            trigger={
              <button
                type="button"
                className={SEND_BUTTON_CLASS}
                data-testid="wallet-send-hive-button"
              >
                {t('wallet.hive_card.send')}
              </button>
            }
          />
        </div>
      </div>

      <StakedHiveBlock
        username={username}
        figures={figures}
        liquidHive={figures.liquidHive}
        dynamicGlobal={dynamicGlobal}
      />
    </div>
  );
}
