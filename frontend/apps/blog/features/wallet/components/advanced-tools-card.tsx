'use client';

import Big from 'big.js';
import { ArrowLeftRight, ChevronRight, Gift, PiggyBank, Repeat, UserPlus } from 'lucide-react';
import { useTranslation } from '@/blog/i18n/client';
import DelegateDialog from './dialogs/delegate-dialog';
import ConvertDialog from './dialogs/convert-dialog';
import RecurringTransferDialog from './dialogs/recurring-transfer-dialog';
import ClaimAccountDialog from './dialogs/claim-account-dialog';

const CARD_CLASS = 'rounded-[18px] border border-[#ebebeb] bg-white p-5';
const ROW_CLASS =
  'flex w-full items-center gap-[11px] rounded-[11px] px-2 py-2.5 text-left text-[#2a2822] transition-colors hover:bg-[#f6f7f8]';
const ICON_WRAP_CLASS =
  'flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[9px] bg-[#f1f3f5] text-[#4b5563]';

function RowLabel({ label, sub }: { label: string; sub: string }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="block text-[13.5px] font-semibold">{label}</span>
      <span className="block text-[11.5px] text-[#9ca3af]">{sub}</span>
    </span>
  );
}

/**
 * Power-user tools rail card. Every row opens a real dialog wired to a real
 * op (Delegate HP / Convert / Recurring transfers) or jumps to the on-page
 * Savings Vault section — except "Claim account tokens", whose dialog is
 * real but whose submit is a labelled TODO (see claim-account-dialog.tsx).
 */
export default function AdvancedToolsCard({
  username,
  netHp,
  hbdBalance,
  pendingClaimedAccounts
}: {
  username: string;
  netHp: Big;
  hbdBalance: Big;
  pendingClaimedAccounts: number;
}) {
  const { t } = useTranslation('common_blog');

  return (
    <div className={CARD_CLASS} data-testid="wallet-advanced-card">
      <div className="mb-1 flex items-center gap-2">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2" aria-hidden>
          <path d="M12 2l2.4 6.5L21 11l-6.6 2.5L12 20l-2.4-6.5L3 11l6.6-2.5z" />
        </svg>
        <span className="text-[14.5px] font-bold text-[#161511]">{t('wallet.advanced.title')}</span>
      </div>
      <p className="mb-3.5 font-serif text-[12.5px] text-[#9ca3af]">{t('wallet.advanced.description')}</p>

      <div className="flex flex-col gap-0.5">
        <DelegateDialog
          username={username}
          netHp={netHp}
          trigger={
            <button type="button" className={ROW_CLASS} data-testid="wallet-advanced-delegate">
              <span className={ICON_WRAP_CLASS}>
                <UserPlus className="h-4 w-4" />
              </span>
              <RowLabel label={t('wallet.advanced.delegate.label')} sub={t('wallet.advanced.delegate.sub')} />
              <ChevronRight className="h-[15px] w-[15px] shrink-0 text-[#cbd0d6]" />
            </button>
          }
        />

        <ClaimAccountDialog
          pendingClaimedAccounts={pendingClaimedAccounts}
          trigger={
            <button type="button" className={ROW_CLASS} data-testid="wallet-advanced-claim-account">
              <span className={ICON_WRAP_CLASS}>
                <Gift className="h-4 w-4" />
              </span>
              <RowLabel
                label={t('wallet.advanced.claim_account.label')}
                sub={t('wallet.advanced.claim_account.sub')}
              />
              <ChevronRight className="h-[15px] w-[15px] shrink-0 text-[#cbd0d6]" />
            </button>
          }
        />

        <ConvertDialog
          username={username}
          hbdBalance={hbdBalance}
          trigger={
            <button type="button" className={ROW_CLASS} data-testid="wallet-advanced-convert">
              <span className={ICON_WRAP_CLASS}>
                <ArrowLeftRight className="h-4 w-4" />
              </span>
              <RowLabel label={t('wallet.advanced.convert.label')} sub={t('wallet.advanced.convert.sub')} />
              <ChevronRight className="h-[15px] w-[15px] shrink-0 text-[#cbd0d6]" />
            </button>
          }
        />

        <RecurringTransferDialog
          username={username}
          trigger={
            <button type="button" className={ROW_CLASS} data-testid="wallet-advanced-recurring">
              <span className={ICON_WRAP_CLASS}>
                <Repeat className="h-4 w-4" />
              </span>
              <RowLabel label={t('wallet.advanced.recurring.label')} sub={t('wallet.advanced.recurring.sub')} />
              <ChevronRight className="h-[15px] w-[15px] shrink-0 text-[#cbd0d6]" />
            </button>
          }
        />

        <a href="#savings-vault" className={ROW_CLASS} data-testid="wallet-advanced-savings">
          <span className={ICON_WRAP_CLASS}>
            <PiggyBank className="h-4 w-4" />
          </span>
          <RowLabel label={t('wallet.advanced.savings.label')} sub={t('wallet.advanced.savings.sub')} />
          <ChevronRight className="h-[15px] w-[15px] shrink-0 text-[#cbd0d6]" />
        </a>
      </div>
    </div>
  );
}
