'use client';

import { ReactNode } from 'react';
import Big from 'big.js';
import { formatTokenAmount } from '../lib/format-amount';
import TokenIcon from './token-icon';
import SavingsDepositDialog from './dialogs/savings-deposit-dialog';
import SavingsWithdrawDialog from './dialogs/savings-withdraw-dialog';

// W-2/W-3: Deposit was bg-surface-ok-7 and both were rounded-[10px].
const DEPOSIT_BUTTON_CLASS =
  'rounded-[14px] bg-surface-brand-12 px-[15px] py-2 text-[13px] leading-[20px] font-semibold text-ink-27 transition-colors hover:bg-surface-brand-17';
const WITHDRAW_BUTTON_CLASS =
  'rounded-[14px] border border-line-11 bg-surface-1 px-[15px] py-2 text-[13px] leading-[20px] font-semibold text-ink-7 transition-colors hover:bg-surface-16';

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
    // ★ W-fix (2026-08-13, map item 1): flex-wrap + gap-x/gap-y, not a rigid
    // non-wrapping row. See the inner button group below — that's the change
    // that actually matters at narrow widths.
    <div
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 rounded-[14px] border border-line-7 bg-surface-1 px-[18px] py-4"
      data-testid={testId}
    >
      <div className="min-w-0 max-w-[420px]">
        <div className="mb-1 flex items-center gap-2">
          <TokenIcon currency={currency} size={20} />
          <span className="text-[15px] leading-[24px] font-bold text-ink-4">{title}</span>
          <span
            className={`rounded-[7px] px-2 py-[2px] text-[12px] font-bold ${
              chipTone === 'green' ? 'bg-surface-ok-5 text-ink-ok-2' : 'bg-surface-23 text-ink-10'
            }`}
          >
            {chip}
          </span>
        </div>
        {description ? <p className="font-serif text-[13px] leading-[20px] text-ink-10">{description}</p> : null}
      </div>
      {/* ★ THE load-bearing change (map item 1). Wrapping the outer row
          alone is not enough: this button group is ~370px on its own
          against a ~304px content box at 390px viewport width, so it must
          be able to wrap INTERNALLY too. `shrink-0` (removed) would not
          have helped either — buttons don't shrink below their own text.
          No Tailwind breakpoint sits in the right place (this only fits
          unwrapped from a card content width of ~573px, i.e. ~943px
          viewport in the md 2-column grid), so this wraps at every size,
          not at a `sm:`/`md:` variant — the desktop row is still one line
          because 370px fits comfortably above ~943px, no breakpoint needed. */}
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2.5">
        <span className="font-sans text-[20px] leading-[30px] font-bold tabular-nums text-ink-2">
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
