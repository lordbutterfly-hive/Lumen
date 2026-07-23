'use client';

import { ReactNode } from 'react';
import Big from 'big.js';
import { formatTokenAmount } from '../lib/format-amount';
import TokenIcon from './token-icon';
import SavingsDepositDialog from './dialogs/savings-deposit-dialog';
import SavingsWithdrawDialog from './dialogs/savings-withdraw-dialog';

/**
 * One HIVE or HBD row inside the Savings Vault panel. Generic over currency
 * so both slots (HIVE: 3-day-unlock chip, no APR; HBD: APR chip + claimable
 * + Claim now) share the same markup — `chip` and `extra` are the only bits
 * that differ.
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
  description: string;
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
        <p className="font-serif text-[13px] text-[#6b7280]">{description}</p>
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
              className="rounded-[10px] bg-[#2f7d4f] px-[15px] py-2 text-[13px] font-semibold text-white hover:bg-[#256640]"
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
              className="rounded-[10px] border border-[#e4e6e9] bg-white px-[15px] py-2 text-[13px] font-semibold text-[#3f4650] hover:bg-[#f6f7f8]"
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
