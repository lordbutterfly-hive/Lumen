'use client';

import Big from 'big.js';
import { formatTokenAmount } from '@/blog/features/wallet/lib/format-amount';
import TokenIcon from '@/blog/features/wallet/components/token-icon';

/**
 * Read-only copy of features/wallet/components/savings-slot-card.tsx for the
 * public wallet page. Removed: SavingsDepositDialog, SavingsWithdrawDialog
 * and their Deposit and Withdraw buttons. The username and liquidBalance
 * props existed only to feed those dialogs, so they are gone too. The
 * private extraAction slot (the Claim now button) is replaced with a plain
 * accrued text prop.
 */
export default function PublicSavingsSlot({
  currency,
  title,
  chip,
  chipTone,
  description,
  balance,
  accrued,
  testId
}: {
  currency: 'HIVE' | 'HBD';
  title: string;
  chip: string;
  chipTone: 'neutral' | 'green';
  description?: string;
  balance: Big;
  accrued?: string | null;
  testId: string;
}) {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 rounded-card border border-line-7 bg-surface-1 px-[18px] py-3"
      data-testid={testId}
    >
      <div className="min-w-0 max-w-[420px]">
        <div className="mb-1 flex items-center gap-2">
          <TokenIcon currency={currency} size={20} />
          <span className="text-[16px] leading-[24px] font-semibold text-ink-4">{title}</span>
          <span
            className={`rounded-control px-2 py-[2px] text-caption font-medium tabular-nums ${
 chipTone === 'green' ? 'bg-surface-ok-5 text-ink-ok-2' : 'bg-surface-23 text-ink-10'
 }`}
          >
            {chip}
          </span>
        </div>
        {description ? <p className="font-ui text-caption text-ink-10">{description}</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2.5">
        <span className="font-num font-semibold text-[22px] leading-[30px] text-ink-2">
          {formatTokenAmount(balance)}
        </span>
        {accrued ? (
          <span className="text-caption tabular-nums text-ink-14" data-testid={`${testId}-accrued`}>
            {accrued}
          </span>
        ) : null}
      </div>
    </div>
  );
}
