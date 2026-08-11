'use client';

import { ReactNode } from 'react';
import Big from 'big.js';
import { formatTokenAmount } from '../lib/format-amount';
import TokenIcon from './token-icon';
import SavingsDepositDialog from './dialogs/savings-deposit-dialog';
import SavingsWithdrawDialog from './dialogs/savings-withdraw-dialog';

// W-2/W-3: Deposit was bg-[#2f7d4f] and both were rounded-[10px].
const DEPOSIT_BUTTON_CLASS =
  'rounded-[14px] bg-[#c0392b] px-[15px] py-2 text-[13px] font-semibold text-white transition-colors hover:bg-[#96271b]';
const WITHDRAW_BUTTON_CLASS =
  'rounded-[14px] border border-[#e4e6e9] bg-white px-[15px] py-2 text-[13px] font-semibold text-[#3f4650] transition-colors hover:bg-[#f6f7f8]';

/**
 * One HIVE or HBD row inside the Savings Vault panel. Generic over currency
 * so both slots (HIVE: no APR; HBD: APR chip + claimable + Claim now) share the
 * same markup — `chip` and `extra` are the only bits that differ.
 *
 * ★ `description` is OPTIONAL (W-6). The 3-day withdrawal rule was stated three
 * times inside this one card: on the HIVE chip, in the panel's description and
 * again in this row's description. It is now stated once, at panel level, where
 * it is true of both currencies — which leaves the HIVE row with nothing of its
 * own to say, so it says nothing rather than repeating the panel above it.
 */
export default function SavingsSlotCard({
  currency,
  title,
  chip,
  chipTone,
  description,
  balance,
  username,
  liquidBalance,
  depositLabel,
  withdrawLabel,
  extraAction,
  testId
}: {
  currency: 'HIVE' | 'HBD';
  title: string;
  chip: string;
  chipTone: 'neutral' | 'green';
  description?: string;
  balance: Big;
  username: string;
  liquidBalance: Big;
  depositLabel: string;
  withdrawLabel: string;
  extraAction?: ReactNode;
  testId: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-[14px] border border-[#e7eee9] bg-white px-[18px] py-4" data-testid={testId}>
      <div className="max-w-[420px]">
        <div className="mb-1 flex items-center gap-2">
          <TokenIcon currency={currency} size={20} />
          <span className="text-[15px] font-bold text-[#2a2822]">{title}</span>
          <span
            className={`rounded-[7px] px-2 py-[2px] text-[11.5px] font-bold ${
              chipTone === 'green' ? 'bg-[#e9f5ee] text-[#2f7d4f]' : 'bg-[#f1f3f5] text-[#6b7280]'
            }`}
          >
            {chip}
          </span>
        </div>
        {description ? <p className="font-serif text-[13px] text-[#6b7280]">{description}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-3.5">
        <span className="font-sans text-[19px] font-bold tabular-nums text-[#161511]">
          {formatTokenAmount(balance)}
        </span>
        <SavingsDepositDialog
          currency={currency}
          username={username}
          liquidBalance={liquidBalance}
          trigger={
            <button
              type="button"
              className={DEPOSIT_BUTTON_CLASS}
              data-testid={`${testId}-deposit`}
            >
              {depositLabel}
            </button>
          }
        />
        <SavingsWithdrawDialog
          currency={currency}
          username={username}
          savingsBalance={balance}
          trigger={
            <button
              type="button"
              className={WITHDRAW_BUTTON_CLASS}
              data-testid={`${testId}-withdraw`}
            >
              {withdrawLabel}
            </button>
          }
        />
        {extraAction}
      </div>
    </div>
  );
}
