'use client';

import { ReactNode, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Input } from '@ui/components/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@ui/components/select';
import { toast } from '@ui/components/hooks/use-toast';
import { handleError } from '@ui/lib/handle-error';
import { getAccount } from '@transaction/lib/hive-api';
import { getAsset } from '@transaction/lib/utils';
import { useTranslation } from '@/blog/i18n/client';
import { useRecurringTransferMutation } from '../../hooks/use-recurring-transfer-mutation';
import WalletDialogShell from './shared/wallet-dialog-shell';
import RecipientField from './shared/recipient-field';
import { FieldError } from './shared/field-error';

const buildSchema = (t: (key: string, opts?: Record<string, unknown>) => string) =>
  z.object({
    to: z
      .string({ message: t('wallet.dialogs.common.recipient_required') })
      .min(3)
      .max(16)
      .refine(async (value) => (typeof window === 'undefined' ? true : !!(await getAccount(value))), {
        message: t('wallet.dialogs.common.recipient_not_found')
      }),
    amount: z.number({ message: t('wallet.dialogs.common.amount_positive') }).positive({
      message: t('wallet.dialogs.common.amount_positive')
    }),
    currency: z.enum(['HIVE', 'HBD']),
    memo: z.string().max(2048).optional(),
    recurrence: z.number().int().min(24, { message: t('wallet.dialogs.recurring.recurrence_hours') }),
    executions: z.number().int().min(2, { message: t('wallet.dialogs.recurring.executions') })
  });

type RecurringFormValues = z.infer<ReturnType<typeof buildSchema>>;

export default function RecurringTransferDialog({ trigger, username }: { trigger: ReactNode; username: string }) {
  const { t } = useTranslation('common_blog');
  const [open, setOpen] = useState(false);
  const recurringMutation = useRecurringTransferMutation();

  const schema = useMemo(() => buildSchema(t), [t]);
  const form = useForm<RecurringFormValues>({
    resolver: zodResolver(schema),
    mode: 'onSubmit',
    defaultValues: { currency: 'HIVE', recurrence: 24, executions: 2 }
  });

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
      onOpenChange={setOpen}
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
        <label className="text-[13px] font-semibold text-[#3f4650]">{t('wallet.dialogs.common.amount')}</label>
        <div className="flex gap-2">
          <Input
            {...form.register('amount', { valueAsNumber: true })}
            type="number"
            step="any"
            className="tabular-nums"
          />
          <Select
            defaultValue="HIVE"
            onValueChange={(value: 'HIVE' | 'HBD') => form.setValue('currency', value)}
          >
            <SelectTrigger className="w-24">
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
        <FieldError message={form.formState.errors.amount?.message} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <label className="text-[13px] font-semibold text-[#3f4650]">
            {t('wallet.dialogs.recurring.recurrence_hours')}
          </label>
          <Input {...form.register('recurrence', { valueAsNumber: true })} type="number" min={24} />
          <FieldError message={form.formState.errors.recurrence?.message} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-[13px] font-semibold text-[#3f4650]">
            {t('wallet.dialogs.recurring.executions')}
          </label>
          <Input {...form.register('executions', { valueAsNumber: true })} type="number" min={2} />
          <FieldError message={form.formState.errors.executions?.message} />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="text-[13px] font-semibold text-[#3f4650]">{t('wallet.dialogs.common.memo')}</label>
        <Input {...form.register('memo')} placeholder={t('wallet.dialogs.common.memo')} />
      </div>
    </WalletDialogShell>
  );
}
