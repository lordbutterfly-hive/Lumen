'use client';

import { GetDynamicGlobalPropertiesResponse } from '@hiveio/wax';
import { Chain } from '@transaction/lib/chain';
import { useTranslation } from '@/blog/i18n/client';
import { WalletFigures } from '../lib/wallet-derived';
import { formatTokenAmount } from '../lib/format-amount';
import TokenIcon from './token-icon';
import SendDialog from './dialogs/send-dialog';
import StakedHiveBlock from './staked-hive-block';

const CARD_CLASS = 'mb-[18px] rounded-[18px] border border-[#ebebeb] bg-white p-6';

export default function HiveTokenCard({
  username,
  figures,
  dynamicGlobal,
  chain
}: {
  username: string;
  figures: WalletFigures;
  dynamicGlobal: GetDynamicGlobalPropertiesResponse | null;
  chain: Chain | null;
}) {
  const { t } = useTranslation('common_blog');

  return (
    <div className={CARD_CLASS} data-testid="wallet-hive-card">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3.5">
          <TokenIcon currency="HIVE" />
          <div>
            <div className="text-[17px] font-bold text-[#161511]">{t('wallet.hive_card.name')}</div>
            <div className="text-[13.5px] text-[#6b7280]">{t('wallet.hive_card.description')}</div>
          </div>
        </div>
        <div className="flex items-center gap-3.5">
          <span
            className="font-sans text-2xl font-bold tabular-nums text-[#161511]"
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
                className="flex items-center gap-1.5 rounded-[11px] bg-[#2f7d4f] px-[18px] py-2.5 text-[13.5px] font-semibold text-white hover:bg-[#256640]"
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
        chain={chain}
      />
    </div>
  );
}
