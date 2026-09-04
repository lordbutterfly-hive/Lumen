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
import { useSavingsDepositMutation } from '../../hooks/use-savings-mutations';
import WalletDialogShell from './shared/wallet-dialog-shell';
import AmountField from './shared/amount-field';
import { useWalletDialog } from './shared/use-wallet-dialog';
import { buildAmountSchema } from './shared/amount-schema';

const buildSchema = (balance: Big, t: (key: string, opts?: Record<string, unknown>) => string) =>
  z.object({
    amount: buildAmountSchema({ max: balance }, t)
  });

type DepositFormValues = z.infer<ReturnType<typeof buildSchema>>;

/** Deposit into the caller's own HIVE or HBD savings (transfer_to_savings_operation). */
export default function SavingsDepositDialog({
  trigger,
  currency,
  username,
  liquidBalance,
  defaultOpen
}: {
  trigger: ReactNode;
  currency: 'HIVE' | 'HBD';
  username: string;
  liquidBalance: Big;
  /** See use-wallet-dialog.ts — set by lazy-wallet-dialog.tsx on first load. */
  defaultOpen?: boolean;
}) {
  const { t } = useTranslation('common_blog');
  const depositMutation = useSavingsDepositMutation();

  const schema = useMemo(() => buildSchema(liquidBalance, t), [liquidBalance, t]);
  const form = useForm<DepositFormValues>({ resolver: zodResolver(schema), mode: 'onSubmit' });
  const { open, setOpen, onOpenChange } = useWalletDialog(form, defaultOpen);

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const amount = await getAsset(values.amount.toString(), currency);
      await depositMutation.mutateAsync({ fromAccount: username, toAccount: username, memo: '', amount });
      toast({
        title: t('wallet.dialogs.common.success_title'),
        description: t('wallet.savings.deposit'),
        variant: 'success'
      });
      setOpen(false);
      form.reset();
    } catch (error) {
      handleError(error, { method: 'walletSavingsDeposit', params: { currency, ...values } });
    }
  });

  return (
    <WalletDialogShell
      trigger={trigger}
      title={t('wallet.dialogs.savings_deposit.title', { currency })}
      description={t('wallet.dialogs.savings_deposit.description', { currency })}
      open={open}
      onOpenChange={onOpenChange}
      onSubmit={onSubmit}
      submitLabel={t('wallet.savings.deposit')}
      cancelLabel={t('wallet.dialogs.common.cancel')}
      isSubmitting={depositMutation.isPending}
    >
      <AmountField
        label={t('wallet.dialogs.common.amount')}
        currency={currency}
        balanceLabel={`${t('wallet.dialogs.common.balance')}: ${liquidBalance.toFixed(3)}`}
        onUseMax={() => form.setValue('amount', liquidBalance.toNumber())}
        register={form.register('amount', { valueAsNumber: true })}
        error={form.formState.errors.amount?.message}
        testId="wallet-savings-deposit-amount"
      />
    </WalletDialogShell>
  );
}
