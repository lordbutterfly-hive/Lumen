'use client';

import { UseFormRegisterReturn } from 'react-hook-form';
import { Input } from '@ui/components/input';
import { Icons } from '@ui/components/icons';
import { FieldError } from './field-error';

/**
 * Labeled "@account" input. Existence is validated by the parent dialog's
 * zod schema (async refine against getAccount) — this component is just the
 * field chrome so every dialog shares the same look.
 */
export default function RecipientField({
  label,
  register,
  error,
  disabled,
  testId
}: {
  label: string;
  register: UseFormRegisterReturn;
  error?: string;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[13px] font-semibold text-[#3f4650]">{label}</label>
      <div className="relative">
        <Icons.atSign className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#9ca3af]" />
        <Input {...register} disabled={disabled} placeholder="username" data-testid={testId} className="pl-9" />
      </div>
      <FieldError message={error} />
    </div>
  );
}
