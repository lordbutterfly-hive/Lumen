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
import { usePowerUpMutation } from '../../hooks/use-power-mutations';
import WalletDialogShell from './shared/wallet-dialog-shell';
import AmountField from './shared/amount-field';
import { useWalletDialog } from './shared/use-wallet-dialog';
import { buildAmountSchema } from './shared/amount-schema';

const buildSchema = (balance: Big, t: (key: string, opts?: Record<string, unknown>) => string) =>
  z.object({
    amount: buildAmountSchema({ max: balance }, t)
  });

type PowerUpFormValues = z.infer<ReturnType<typeof buildSchema>>;

export default function PowerUpDialog({
  trigger,
  username,
  hiveBalance,
  defaultOpen
}: {
  trigger: ReactNode;
  username: string;
  hiveBalance: Big;
  /** See use-wallet-dialog.ts — set by lazy-wallet-dialog.tsx on first load. */
  defaultOpen?: boolean;
}) {
  const { t } = useTranslation('common_blog');
  const powerUpMutation = usePowerUpMutation();

  const schema = useMemo(() => buildSchema(hiveBalance, t), [hiveBalance, t]);
  const form = useForm<PowerUpFormValues>({ resolver: zodResolver(schema), mode: 'onSubmit' });
  const { open, setOpen, onOpenChange } = useWalletDialog(form, defaultOpen);

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const amount = await getAsset(values.amount.toString(), 'HIVE');
      await powerUpMutation.mutateAsync({ fromAccount: username, toAccount: username, amount });
      toast({ title: t('wallet.dialogs.common.success_title'), description: t('wallet.staked.stake'), variant: 'success' });
      setOpen(false);
      form.reset();
    } catch (error) {
      handleError(error, { method: 'walletPowerUp', params: values });
    }
  });

  return (
    <WalletDialogShell
      trigger={trigger}
      title={t('wallet.dialogs.power_up.title')}
      description={t('wallet.dialogs.power_up.description')}
      open={open}
      onOpenChange={onOpenChange}
      onSubmit={onSubmit}
      submitLabel={t('wallet.staked.stake')}
      cancelLabel={t('wallet.dialogs.common.cancel')}
      isSubmitting={powerUpMutation.isPending}
    >
      <AmountField
        label={t('wallet.dialogs.common.amount')}
        currency="HIVE"
        balanceLabel={`${t('wallet.dialogs.common.balance')}: ${hiveBalance.toFixed(3)}`}
        onUseMax={() => form.setValue('amount', hiveBalance.toNumber())}
        register={form.register('amount', { valueAsNumber: true })}
        error={form.formState.errors.amount?.message}
        testId="wallet-power-up-amount"
      />
    </WalletDialogShell>
  );
}
