'use client';

import Big from 'big.js';
import { useTranslation } from '@/blog/i18n/client';
import { formatTokenAmount } from '../lib/format-amount';
import TokenIcon from './token-icon';
import SendDialog from './dialogs/send-dialog';

const CARD_CLASS = 'mb-[18px] rounded-panel border border-line-9 bg-surface-1 p-6';
// Same button as the HIVE card's Send — see hive-token-card.tsx (W-2/W-3).
const SEND_BUTTON_CLASS =
  'flex items-center gap-1.5 rounded-card bg-surface-brand-12 px-[18px] py-2.5 text-[14px] leading-[22px] font-semibold text-ink-27 transition-colors hover:bg-surface-brand-17';

export default function HbdTokenCard({ username, liquidHbd }: { username: string; liquidHbd: Big }) {
  const { t } = useTranslation('common_blog');

  return (
    <div className={CARD_CLASS} data-testid="wallet-hbd-card">
      {/* ★ Same mobile-overflow fix as hive-token-card.tsx (2026-08-14): this
          row had no `flex-wrap`, so the name/description block and the
          balance + Send button were forced onto one unbreakable line at
          390px — wider than the card's ~294px content box whenever the HBD
          balance runs long. Preventive fix for the identical structure, not
          just the reported HIVE card: this card was one large balance away
          from the same overlap/clip. See hive-token-card.tsx for the full
          measurement writeup. */}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="flex items-center gap-3.5">
          <TokenIcon currency="HBD" />
          <div>
            <div className="text-[17px] leading-[26px] font-bold text-ink-2">{t('wallet.hbd_card.name')}</div>
            <div className="text-[14px] leading-[22px] text-ink-10">{t('wallet.hbd_card.description')}</div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2.5">
          <span className="font-sans text-2xl font-bold tabular-nums text-ink-2" data-testid="wallet-hbd-balance">
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
