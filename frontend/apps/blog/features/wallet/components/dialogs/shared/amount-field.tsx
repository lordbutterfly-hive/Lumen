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
      <label className="text-[13px] leading-[20px] font-semibold text-ink-7">{label}</label>
      <div className="relative">
        <Input
          {...register}
          /* ★ TEXT, NOT number — A COMMA DECIMAL WAS SILENTLY 10x-ing THE AMOUNT
             (2026-08-12). On `<input type="number">` Chrome DISCARDS a comma
             keystroke rather than rejecting it, so a person typing "1,5" — which is
             how a decimal is written in es, fr, it, pl and ru, five of the nine
             locales this app ships — ends up with the digits concatenated:

               type="number"  typed "1,5" -> value "15"   (+value = 15)
               type="text"    typed "1,5" -> value "1,5"  (+value = NaN)

             Reproduced in a bare browser page with no app code involved. `register(...,
             { valueAsNumber: true })` then handed zod a perfectly legitimate 15, so
             every check passed and it reached the signing boundary at ten times the
             intended amount.

             `type="text"` makes it NaN instead, which fails the `z.number()` schema —
             the amount is REJECTED rather than guessed at. Deliberately no
             comma-to-dot rewrite: "1,000" is one thousand to a British reader and one
             to a German one, and silently picking either is the same class of bug we
             are removing. `inputMode="decimal"` keeps the numeric keypad on mobile.

             NOTE: pasting a comma was always safe — `type="number"` yields "" -> 0,
             which already failed the positive check. Only TYPING was dangerous, which
             is why automated `fill()` tests never caught it. */
          type="text"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.000"
          data-testid={testId}
          className="pr-16 font-sans tabular-nums"
        />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[13px] leading-[20px] font-semibold text-ink-14">
          {currency}
        </span>
      </div>
      <button
        type="button"
        onClick={onUseMax}
        className="w-fit text-[12px] font-medium text-ink-brand-6 underline underline-offset-2 hover:text-ink-brand-4"
      >
        {balanceLabel}
      </button>
      <FieldError message={error} />
    </div>
  );
}
