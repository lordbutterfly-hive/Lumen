'use client';

import { ReactNode, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import Big from 'big.js';
import { toast } from '@ui/components/hooks/use-toast';
import { handleError } from '@ui/lib/handle-error';
import { getAccount } from '@transaction/lib/hive-api';
import { getAsset } from '@transaction/lib/utils';
import { useTranslation } from '@/blog/i18n/client';
import { useDelegateMutation } from '../../hooks/use-delegate-mutation';
import WalletDialogShell from './shared/wallet-dialog-shell';
import RecipientField from './shared/recipient-field';
import AmountField from './shared/amount-field';

const buildSchema = (maxHp: Big, t: (key: string, opts?: Record<string, unknown>) => string) =>
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
      // 0 is allowed on purpose — delegating 0 HP revokes an existing delegation.
      .min(0)
      .refine((value) => value <= maxHp.toNumber(), { message: t('wallet.dialogs.common.amount_exceeds_balance') })
  });

type DelegateFormValues = z.infer<ReturnType<typeof buildSchema>>;

export default function DelegateDialog({
  trigger,
  username,
  netHp
}: {
  trigger: ReactNode;
  username: string;
  netHp: Big;
}) {
  const { t } = useTranslation('common_blog');
  const [open, setOpen] = useState(false);
  const delegateMutation = useDelegateMutation();

  const schema = useMemo(() => buildSchema(netHp, t), [netHp, t]);
  const form = useForm<DelegateFormValues>({ resolver: zodResolver(schema), mode: 'onSubmit' });

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const hp = await getAsset(values.amount.toString(), 'HIVE');
      await delegateMutation.mutateAsync({ delegator: username, delegatee: values.to, hp });
      toast({
        title: t('wallet.dialogs.common.success_title'),
        description: t('wallet.advanced.delegate.label'),
        variant: 'success'
      });
      setOpen(false);
      form.reset();
    } catch (error) {
      handleError(error, { method: 'walletDelegate', params: values });
    }
  });

  return (
    <WalletDialogShell
      trigger={trigger}
      title={t('wallet.dialogs.delegate.title')}
      description={t('wallet.dialogs.delegate.description')}
      open={open}
      onOpenChange={setOpen}
      onSubmit={onSubmit}
      submitLabel={t('wallet.advanced.delegate.label')}
      cancelLabel={t('wallet.dialogs.common.cancel')}
      isSubmitting={delegateMutation.isPending}
    >
      <RecipientField
        label={t('wallet.dialogs.common.to')}
        register={form.register('to')}
        error={form.formState.errors.to?.message}
        testId="wallet-delegate-to"
      />
      <AmountField
        label={t('wallet.dialogs.common.amount')}
        currency="HP"
        balanceLabel={`${t('wallet.dialogs.common.balance')}: ${netHp.toFixed(3)}`}
        onUseMax={() => form.setValue('amount', netHp.toNumber())}
        register={form.register('amount', { valueAsNumber: true })}
        error={form.formState.errors.amount?.message}
        testId="wallet-delegate-amount"
      />
    </WalletDialogShell>
  );
}
