'use client';

import { ReactNode, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import Big from 'big.js';
import { toast } from '@ui/components/hooks/use-toast';
import { handleError } from '@ui/lib/handle-error';
import { getAsset } from '@transaction/lib/utils';
import { useTranslation } from '@/blog/i18n/client';
import { useConvertMutation } from '../../hooks/use-convert-mutation';
import WalletDialogShell from './shared/wallet-dialog-shell';
import AmountField from './shared/amount-field';
import { useWalletDialog } from './shared/use-wallet-dialog';
import { buildAmountSchema } from './shared/amount-schema';

const buildSchema = (hbdBalance: Big, t: (key: string, opts?: Record<string, unknown>) => string) =>
  z.object({
    amount: buildAmountSchema({ max: hbdBalance }, t)
  });

type ConvertFormValues = z.infer<ReturnType<typeof buildSchema>>;

export default function ConvertDialog({
  trigger,
  username,
  hbdBalance,
  defaultOpen
}: {
  trigger: ReactNode;
  username: string;
  hbdBalance: Big;
  /** See use-wallet-dialog.ts — set by lazy-wallet-dialog.tsx on first load. */
  defaultOpen?: boolean;
}) {
  const { t } = useTranslation('common_blog');
  const convertMutation = useConvertMutation();

  const schema = useMemo(() => buildSchema(hbdBalance, t), [hbdBalance, t]);
  const form = useForm<ConvertFormValues>({ resolver: zodResolver(schema), mode: 'onSubmit' });
  const { open, setOpen, onOpenChange } = useWalletDialog(form, defaultOpen);

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const amount = await getAsset(values.amount.toString(), 'HBD');
      await convertMutation.mutateAsync({ owner: username, amount });
      toast({
        title: t('wallet.dialogs.common.success_title'),
        description: t('wallet.advanced.convert.label'),
        variant: 'success'
      });
      setOpen(false);
      form.reset();
    } catch (error) {
      handleError(error, { method: 'walletConvert', params: values });
    }
  });

  return (
    <WalletDialogShell
      trigger={trigger}
      title={t('wallet.dialogs.convert.title')}
      description={t('wallet.dialogs.convert.description')}
      open={open}
      onOpenChange={onOpenChange}
      onSubmit={onSubmit}
      submitLabel={t('wallet.dialogs.common.next')}
      cancelLabel={t('wallet.dialogs.common.cancel')}
      isSubmitting={convertMutation.isPending}
    >
      <AmountField
        label={t('wallet.dialogs.common.amount')}
        currency="HBD"
        balanceLabel={`${t('wallet.dialogs.common.balance')}: ${hbdBalance.toFixed(3)}`}
        onUseMax={() => form.setValue('amount', hbdBalance.toNumber())}
        register={form.register('amount', { valueAsNumber: true })}
        error={form.formState.errors.amount?.message}
        testId="wallet-convert-amount"
      />
    </WalletDialogShell>
  );
}
