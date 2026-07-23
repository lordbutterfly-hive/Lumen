'use client';

import { ReactNode, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import Big from 'big.js';
import { Input } from '@ui/components/input';
import { toast } from '@ui/components/hooks/use-toast';
import { handleError } from '@ui/lib/handle-error';
import { getAccount } from '@transaction/lib/hive-api';
import { getAsset } from '@transaction/lib/utils';
import { useTranslation } from '@/blog/i18n/client';
import { useSendMutation } from '../../hooks/use-send-mutation';
import WalletDialogShell from './shared/wallet-dialog-shell';
import RecipientField from './shared/recipient-field';
import AmountField from './shared/amount-field';

const buildSchema = (balance: Big, t: (key: string, opts?: Record<string, unknown>) => string) =>
  z.object({
    to: z
      .string({ message: t('wallet.dialogs.common.recipient_required') })
      .min(3)
      .max(16)
      .refine(async (value) => (typeof window === 'undefined' ? true : !!(await getAccount(value))), {
        message: t('wallet.dialogs.common.recipient_not_found')
      }),
    amount: z
      .number({ message: t('wallet.dialogs.common.amount_positive') })
      .positive({ message: t('wallet.dialogs.common.amount_positive') })
      .refine((value) => value <= balance.toNumber(), {
        message: t('wallet.dialogs.common.amount_exceeds_balance')
      })
      .refine((value) => /^\d+(\.\d{1,3})?$/.test(value.toString()), {
        message: t('wallet.dialogs.common.amount_precision')
      }),
    memo: z.string().max(2048).optional()
  });

type SendFormValues = z.infer<ReturnType<typeof buildSchema>>;

export default function SendDialog({
  trigger,
  currency,
  username,
  balance
}: {
  trigger: ReactNode;
  currency: 'HIVE' | 'HBD';
  username: string;
  balance: Big;
}) {
  const { t } = useTranslation('common_blog');
  const [open, setOpen] = useState(false);
  const sendMutation = useSendMutation();

  const schema = useMemo(() => buildSchema(balance, t), [balance, t]);
  const form = useForm<SendFormValues>({ resolver: zodResolver(schema), mode: 'onSubmit' });

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const amount = await getAsset(values.amount.toString(), currency);
      await sendMutation.mutateAsync({
        fromAccount: username,
        toAccount: values.to,
        memo: values.memo ?? '',
        amount
      });
      toast({ title: t('wallet.dialogs.common.success_title'), description: `${currency} → @${values.to}`, variant: 'success' });
      setOpen(false);
      form.reset();
    } catch (error) {
      handleError(error, { method: 'walletSend', params: { currency, ...values } });
    }
  });

  return (
    <WalletDialogShell
      trigger={trigger}
      title={t('wallet.dialogs.send.title', { currency })}
      description={t('wallet.dialogs.send.description', { currency })}
      open={open}
      onOpenChange={setOpen}
      onSubmit={onSubmit}
      submitLabel={t('wallet.dialogs.common.next')}
      cancelLabel={t('wallet.dialogs.common.cancel')}
      isSubmitting={sendMutation.isPending}
    >
      <div className="flex flex-col gap-1.5">
        <label className="text-[13px] font-semibold text-[#3f4650]">{t('wallet.dialogs.common.from')}</label>
        <Input disabled defaultValue={username} className="text-[#3f4650]" />
      </div>
      <RecipientField
        label={t('wallet.dialogs.common.to')}
        register={form.register('to')}
        error={form.formState.errors.to?.message}
        testId="wallet-send-to"
      />
      <AmountField
        label={t('wallet.dialogs.common.amount')}
        currency={currency}
        balanceLabel={`${t('wallet.dialogs.common.balance')}: ${balance.toFixed(3)}`}
        onUseMax={() => form.setValue('amount', balance.toNumber())}
        register={form.register('amount', { valueAsNumber: true })}
        error={form.formState.errors.amount?.message}
        testId="wallet-send-amount"
      />
      <div className="flex flex-col gap-1.5">
        <label className="text-[13px] font-semibold text-[#3f4650]">{t('wallet.dialogs.common.memo')}</label>
        <Input {...form.register('memo')} placeholder={t('wallet.dialogs.common.memo')} />
      </div>
    </WalletDialogShell>
  );
}
