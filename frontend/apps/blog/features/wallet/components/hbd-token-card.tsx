'use client';

import Big from 'big.js';
import { useTranslation } from '@/blog/i18n/client';
import { formatTokenAmount } from '../lib/format-amount';
import TokenIcon from './token-icon';
import SendDialog from './dialogs/send-dialog';

const CARD_CLASS = 'mb-[18px] rounded-[18px] border border-[#ebebeb] bg-white p-6';
// Same button as the HIVE card's Send — see hive-token-card.tsx (W-2/W-3).
const SEND_BUTTON_CLASS =
  'flex items-center gap-1.5 rounded-[14px] bg-[#c0392b] px-[18px] py-2.5 text-[14px] leading-[22px] font-semibold text-white transition-colors hover:bg-[#96271b]';

export default function HbdTokenCard({ username, liquidHbd }: { username: string; liquidHbd: Big }) {
  const { t } = useTranslation('common_blog');

  return (
    <div className={CARD_CLASS} data-testid="wallet-hbd-card">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3.5">
          <TokenIcon currency="HBD" />
          <div>
            <div className="text-[17px] leading-[26px] font-bold text-[#161511]">{t('wallet.hbd_card.name')}</div>
            <div className="text-[14px] leading-[22px] text-[#6b7280]">{t('wallet.hbd_card.description')}</div>
          </div>
        </div>
        <div className="flex items-center gap-3.5">
          <span className="font-sans text-2xl font-bold tabular-nums text-[#161511]" data-testid="wallet-hbd-balance">
            {formatTokenAmount(liquidHbd)}
          </span>
          <SendDialog
            currency="HBD"
            username={username}
            balance={liquidHbd}
            trigger={
              <button
                type="button"
                className={SEND_BUTTON_CLASS}
                data-testid="wallet-send-hbd-button"
              >
                {t('wallet.hbd_card.send')}
              </button>
            }
          />
        </div>
      </div>
    </div>
  );
}
