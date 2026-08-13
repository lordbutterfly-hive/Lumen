'use client';

import { ReactNode, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import Big from 'big.js';
import { Input } from '@ui/components/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@ui/components/select';
import { toast } from '@ui/components/hooks/use-toast';
import { handleError } from '@ui/lib/handle-error';
import { getAsset } from '@transaction/lib/utils';
import { useTranslation } from '@/blog/i18n/client';
import { useRecurringTransferMutation } from '../../hooks/use-recurring-transfer-mutation';
import WalletDialogShell from './shared/wallet-dialog-shell';
import RecipientField from './shared/recipient-field';
import { FieldError } from './shared/field-error';
import { useWalletDialog } from './shared/use-wallet-dialog';
import { buildRecipientSchema } from './shared/recipient-schema';
import { isWithinAmountPrecision } from './shared/amount-schema';

type TFn = (key: string, opts?: Record<string, unknown>) => string;

/**
 * ★ Balance check (map item 3). Every other transfer/spend dialog refines
 * `amount` against a balance; this one had NO refine at all — `999999999`
 * against a real `0.000` used to pass clean straight to the mutation. The
 * bound cannot live on the `amount` field itself: it depends on the sibling
 * `currency` field, so it needs an object-level `superRefine` instead of the
 * shared `buildAmountSchema` every other amount field uses (that helper is
 * deliberately NOT reused here for that reason).
 *
 * Bound is `amount <= balance`, not `amount * executions <= balance` —
 * `recurrent_transfer_operation` only needs the balance at each execution
 * time (the first fires at broadcast), so this matches both the chain and
 * every sibling dialog. `amount * executions <= balance` would wrongly block
 * a legitimate salary-style schedule funded over time.
 *
 * ★★★ PRECISION (2026-08-13, A1 review W-2). Deliberately NOT reusing
 * `buildAmountSchema` cost this field the SHARED precision refine as well as
 * the balance bound, and only the balance bound was re-added above. On every
 * other dialog that omission is a bad error message; here it silently
 * CANCELS a schedule:
 *
 *   `getAsset`'s own decimal guard is `value.indexOf('.')`-based
 *   (`packages/transaction/lib/utils.ts:69`), and `"1e-7"` — what
 *   `Number(1e-7).toString()` produces — contains no dot, so it walks
 *   straight past that guard. `Number("1e-7").toFixed(3)` is `"0.000"`, and
 *   on Hive a `recurrent_transfer` with amount 0 is not a tiny payment, it
 *   is the encoding that DELETES the recipient's existing schedule.
 *
 * So the check is not cosmetic here and it must not be a second, hand-written
 * copy that can drift from the seven sibling dialogs again — it is the shared
 * `isWithinAmountPrecision` predicate, imported from the same module those
 * seven use. It also rejects the ordinary `1.2345` case, which used to pass
 * validation and then die at the signing boundary with a generic toast
 * instead of an inline field message.
 */
const buildSchema = (liquidHive: Big, liquidHbd: Big, t: TFn) =>
  z
    .object({
      to: buildRecipientSchema(t),
      amount: z
        .number({ message: t('wallet.dialogs.common.amount_invalid') })
        .positive({ message: t('wallet.dialogs.common.amount_positive') })
        .refine(isWithinAmountPrecision, { message: t('wallet.dialogs.common.amount_precision') }),
      currency: z.enum(['HIVE', 'HBD']),
      memo: z.string().max(2048, { message: t('wallet.dialogs.common.memo_too_long') }).optional(),
      recurrence: z
        .number({ message: t('wallet.dialogs.recurring.recurrence_min') })
        .int({ message: t('wallet.dialogs.recurring.recurrence_min') })
        .min(24, { message: t('wallet.dialogs.recurring.recurrence_min') }),
      executions: z
        .number({ message: t('wallet.dialogs.recurring.executions_min') })
        .int({ message: t('wallet.dialogs.recurring.executions_min') })
        .min(2, { message: t('wallet.dialogs.recurring.executions_min') })
    })
    .superRefine((values, ctx) => {
      const max = values.currency === 'HBD' ? liquidHbd : liquidHive;
      if (Number.isFinite(values.amount) && values.amount > max.toNumber()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['amount'],
          message: t('wallet.dialogs.common.amount_exceeds_balance')
        });
      }
    });

type RecurringFormValues = z.infer<ReturnType<typeof buildSchema>>;

export default function RecurringTransferDialog({
  trigger,
  username,
  liquidHive,
  liquidHbd
}: {
  trigger: ReactNode;
  username: string;
  liquidHive: Big;
  liquidHbd: Big;
}) {
  const { t } = useTranslation('common_blog');
  const recurringMutation = useRecurringTransferMutation();

  const schema = useMemo(() => buildSchema(liquidHive, liquidHbd, t), [liquidHive, liquidHbd, t]);
  const form = useForm<RecurringFormValues>({
    resolver: zodResolver(schema),
    mode: 'onSubmit',
    defaultValues: { currency: 'HIVE', recurrence: 24, executions: 2 }
  });
  const { open, setOpen, onOpenChange } = useWalletDialog(form);
  const currency = form.watch('currency');
  const currencyBalance = currency === 'HBD' ? liquidHbd : liquidHive;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const amount = await getAsset(values.amount.toString(), values.currency);
      await recurringMutation.mutateAsync({
        from: username,
        to: values.to,
        amount,
        memo: values.memo ?? '',
        recurrence: values.recurrence,
        executions: values.executions
      });
      toast({
        title: t('wallet.dialogs.common.success_title'),
        description: t('wallet.advanced.recurring.label'),
        variant: 'success'
      });
      setOpen(false);
      form.reset();
    } catch (error) {
      handleError(error, { method: 'walletRecurringTransfer', params: values });
    }
  });

  return (
    <WalletDialogShell
      trigger={trigger}
      title={t('wallet.dialogs.recurring.title')}
      description={t('wallet.dialogs.recurring.description')}
      open={open}
      onOpenChange={onOpenChange}
      onSubmit={onSubmit}
      submitLabel={t('wallet.dialogs.common.next')}
      cancelLabel={t('wallet.dialogs.common.cancel')}
      isSubmitting={recurringMutation.isPending}
    >
      <RecipientField
        label={t('wallet.dialogs.common.to')}
        register={form.register('to')}
        error={form.formState.errors.to?.message}
        testId="wallet-recurring-to"
      />
      <div className="flex flex-col gap-1.5">
        <label className="text-[13px] leading-[20px] font-semibold text-[#3f4650]">{t('wallet.dialogs.common.amount')}</label>
        <div className="flex gap-2">
          <Input
            {...form.register('amount', { valueAsNumber: true })}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            className="tabular-nums"
            data-testid="wallet-recurring-amount"
          />
          {/* ★ Controlled (map item 5(i)). This Select was uncontrolled
              (`defaultValue` only), so after a successful submit's
              `form.reset()` the form went back to HIVE while the trigger
              kept showing whatever was last picked — the NEXT submit sent
              the currency the screen was not displaying. `value` ties the
              trigger to the same form state `onValueChange` writes to, in
              both directions, so a reset (including the reset-on-reopen this
              build adds, item 5) always shows what the form actually holds. */}
          <Select value={currency} onValueChange={(value: 'HIVE' | 'HBD') => form.setValue('currency', value)}>
            <SelectTrigger className="w-24" data-testid="wallet-recurring-currency">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="HIVE">HIVE</SelectItem>
                <SelectItem value="HBD">HBD</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        {/* ★ Balance + Use-Max (map item 3). Not the shared `AmountField`
            component: its currency slot is a fixed suffix label, not a
            selector, so it cannot host the currency Select above. This
            replicates AmountField's own balance-button/error markup exactly
            so the UX still matches every sibling dialog, and follows the
            SELECTED currency rather than staying latched on HIVE. */}
        <button
          type="button"
          onClick={() => form.setValue('amount', currencyBalance.toNumber())}
          className="w-fit text-[12px] font-medium text-[#c0392b] underline underline-offset-2 hover:text-[#96271b]"
        >
          {`${t('wallet.dialogs.common.balance')}: ${currencyBalance.toFixed(3)}`}
        </button>
        <FieldError message={form.formState.errors.amount?.message} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <label className="text-[13px] leading-[20px] font-semibold text-[#3f4650]">
            {t('wallet.dialogs.recurring.recurrence_hours')}
          </label>
          <Input {...form.register('recurrence', { valueAsNumber: true })} type="text" inputMode="numeric" autoComplete="off" />
          <FieldError message={form.formState.errors.recurrence?.message} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-[13px] leading-[20px] font-semibold text-[#3f4650]">
            {t('wallet.dialogs.recurring.executions')}
          </label>
          <Input {...form.register('executions', { valueAsNumber: true })} type="text" inputMode="numeric" autoComplete="off" />
          <FieldError message={form.formState.errors.executions?.message} />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="text-[13px] leading-[20px] font-semibold text-[#3f4650]">{t('wallet.dialogs.common.memo')}</label>
        <Input {...form.register('memo')} placeholder={t('wallet.dialogs.common.memo')} />
        <FieldError message={form.formState.errors.memo?.message} />
      </div>
    </WalletDialogShell>
  );
}
