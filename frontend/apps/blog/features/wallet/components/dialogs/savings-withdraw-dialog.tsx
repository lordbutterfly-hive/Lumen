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
import { useSavingsWithdrawMutation } from '../../hooks/use-savings-mutations';
import WalletDialogShell from './shared/wallet-dialog-shell';
import AmountField from './shared/amount-field';
import { useWalletDialog } from './shared/use-wallet-dialog';
import { buildAmountSchema } from './shared/amount-schema';

const buildSchema = (savingsBalance: Big, t: (key: string, opts?: Record<string, unknown>) => string) =>
  z.object({
    amount: buildAmountSchema({ max: savingsBalance }, t)
  });

type WithdrawFormValues = z.infer<ReturnType<typeof buildSchema>>;

/**
 * Requests HIVE or HBD out of savings (transfer_from_savings_operation) back
 * to the account's own liquid balance. Clears after Hive's fixed 3-day
 * security delay — filing the request is all a client can do.
 */
export default function SavingsWithdrawDialog({
  trigger,
  currency,
  username,
  savingsBalance,
  defaultOpen
}: {
  trigger: ReactNode;
  currency: 'HIVE' | 'HBD';
  username: string;
  savingsBalance: Big;
  /** See use-wallet-dialog.ts — set by lazy-wallet-dialog.tsx on first load. */
  defaultOpen?: boolean;
}) {
  const { t } = useTranslation('common_blog');
  const withdrawMutation = useSavingsWithdrawMutation();

  const schema = useMemo(() => buildSchema(savingsBalance, t), [savingsBalance, t]);
  const form = useForm<WithdrawFormValues>({ resolver: zodResolver(schema), mode: 'onSubmit' });
  const { open, setOpen, onOpenChange } = useWalletDialog(form, defaultOpen);

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const amount = await getAsset(values.amount.toString(), currency);
      const requestId = Math.floor((Date.now() / 1000) % 4294967295);
      await withdrawMutation.mutateAsync({
        fromAccount: username,
        toAccount: username,
        memo: '',
        amount,
        requestId
      });
      toast({
        title: t('wallet.dialogs.common.success_title'),
        description: t('wallet.savings.withdraw'),
        variant: 'success'
      });
      setOpen(false);
      form.reset();
    } catch (error) {
      handleError(error, { method: 'walletSavingsWithdraw', params: { currency, ...values } });
    }
  });

  return (
    <WalletDialogShell
      trigger={trigger}
      title={t('wallet.dialogs.savings_withdraw.title', { currency })}
      description={t('wallet.dialogs.savings_withdraw.description', { currency })}
      open={open}
      onOpenChange={onOpenChange}
      onSubmit={onSubmit}
      submitLabel={t('wallet.savings.withdraw')}
      cancelLabel={t('wallet.dialogs.common.cancel')}
      isSubmitting={withdrawMutation.isPending}
    >
      <AmountField
        label={t('wallet.dialogs.common.amount')}
        currency={currency}
        balanceLabel={`${t('wallet.dialogs.common.balance')}: ${savingsBalance.toFixed(3)}`}
        onUseMax={() => form.setValue('amount', savingsBalance.toNumber())}
        register={form.register('amount', { valueAsNumber: true })}
        error={form.formState.errors.amount?.message}
        testId="wallet-savings-withdraw-amount"
      />
    </WalletDialogShell>
  );
}
