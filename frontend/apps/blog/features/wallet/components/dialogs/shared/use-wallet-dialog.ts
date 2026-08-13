'use client';

import { useState } from 'react';
import type { FieldValues, UseFormReturn } from 'react-hook-form';

/**
 * Shared open/reset wiring for wallet dialogs (map item 5). Cancel, Escape
 * and an outside click all funnel through Radix's `onOpenChange(false)` —
 * none of those paths ever called `form.reset()`; only the SUCCESS branch of
 * each dialog's own `onSubmit` did. So closing a half-filled dialog any
 * other way and reopening it showed the stale input.
 *
 * Resets on OPEN, not on close: resetting on close blanks the fields while
 * Radix's ~150ms exit animation is still playing and the dialog is still on
 * screen — a visible flash on a money form. Resetting on open is invisible
 * and gives the identical guarantee (every dialog always opens clean).
 *
 * This is also required to make the reopen-clean guarantee actually true for
 * two uncontrolled Radix widgets in these dialogs (the currency `<Select>`
 * and the power-down `<Slider>`): `form.reset()` only resets react-hook-form
 * state, and neither widget reads the form's value back unless the call site
 * also makes it a controlled component (`value={...}`) — see
 * recurring-transfer-dialog.tsx and power-down-dialog.tsx.
 */
export function useWalletDialog<TFieldValues extends FieldValues>(form: UseFormReturn<TFieldValues>) {
  const [open, setOpen] = useState(false);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) form.reset();
  };

  return { open, setOpen, onOpenChange };
}
