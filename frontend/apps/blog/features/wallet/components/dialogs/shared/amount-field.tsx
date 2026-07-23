'use client';

import { UseFormRegisterReturn } from 'react-hook-form';
import { Input } from '@ui/components/input';
import { FieldError } from './field-error';

/**
 * Labeled numeric amount input with a currency suffix and a "Balance: X"
 * quick-fill button — the same UX every wallet transfer dialog needs.
 */
export default function AmountField({
  label,
  currency,
  balanceLabel,
  onUseMax,
  register,
  error,
  testId
}: {
  label: string;
  currency: string;
  balanceLabel: string;
  onUseMax: () => void;
  register: UseFormRegisterReturn;
  error?: string;
  testId?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[13px] font-semibold text-[#3f4650]">{label}</label>
      <div className="relative">
        <Input
          {...register}
          type="number"
          step="any"
          placeholder="0.000"
          data-testid={testId}
          className="pr-16 font-sans tabular-nums"
        />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[13px] font-semibold text-[#9ca3af]">
          {currency}
        </span>
      </div>
      <button
        type="button"
        onClick={onUseMax}
        className="w-fit text-[12px] font-medium text-[#c0392b] underline underline-offset-2 hover:text-[#96271b]"
      >
        {balanceLabel}
      </button>
      <FieldError message={error} />
    </div>
  );
}
