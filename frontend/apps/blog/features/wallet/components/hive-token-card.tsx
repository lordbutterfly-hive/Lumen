'use client';

import { GetDynamicGlobalPropertiesResponse } from '@hiveio/wax';
import { useTranslation } from '@/blog/i18n/client';
import { WalletFigures } from '../lib/wallet-derived';
import { formatTokenAmount } from '../lib/format-amount';
import TokenIcon from './token-icon';
import SendDialog from './dialogs/send-dialog';
import StakedHiveBlock from './staked-hive-block';

const CARD_CLASS = 'mb-[18px] rounded-panel border border-line-9 bg-surface-1 p-6';
// W-2/W-3: was rounded-control bg-surface-ok-7 — the success green used as an
// action colour, at a radius no other control on the page shared.
const SEND_BUTTON_CLASS =
  'flex items-center gap-1.5 rounded-card bg-surface-brand-12 px-[18px] py-2.5 text-[14px] leading-[22px] font-semibold text-ink-27 transition-colors hover:bg-surface-brand-17';

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
      {/* ★ MOBILE OVERFLOW FIX (2026-08-14). This row had no `flex-wrap`, so at
          390px it forced the icon/name block on the left and the balance +
          Send button on the right onto ONE unbreakable line — the balance is a
          tabular-nums number with no spaces (can't line-break) and the Send
          button doesn't shrink below its own padded text, so together they
          were wider than the ~294px card content box (390 viewport - 48px
          page gutter - 48px card padding) and rendered overlapping the name/
          description text instead of dropping to their own line. Same
          `flex-wrap` idiom already shipped for this exact shape in
          savings-slot-card.tsx (2026-08-13). Desktop is unaffected: it only
          wraps when content doesn't fit, and at >=1024px it always does. */}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="flex items-center gap-3.5">
          <TokenIcon currency="HIVE" />
          <div>
            <div className="text-[17px] leading-[26px] font-bold text-ink-2">{t('wallet.hive_card.name')}</div>
            <div className="text-[14px] leading-[22px] text-ink-10">{t('wallet.hive_card.description')}</div>
          </div>
        </div>
        {/* ★ Inner wrap too, not just the outer row. Even once this group has
            the whole card width to itself, a very large balance (whale
            accounts run into 9-figure HIVE) plus the Send button can still
            exceed 294px on one line — wrapping the number onto its own line
            keeps it fully readable instead of pushing the button off-screen,
            which is the required behaviour (no ellipsis truncation for a
            balance). */}
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2.5">
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
