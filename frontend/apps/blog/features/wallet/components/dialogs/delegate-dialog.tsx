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
import { useDelegateMutation } from '../../hooks/use-delegate-mutation';
import WalletDialogShell from './shared/wallet-dialog-shell';
import RecipientField from './shared/recipient-field';
import AmountField from './shared/amount-field';
import { useWalletDialog } from './shared/use-wallet-dialog';
import { buildRecipientSchema } from './shared/recipient-schema';
import { buildAmountSchema } from './shared/amount-schema';

const buildSchema = (maxHp: Big, t: (key: string, opts?: Record<string, unknown>) => string) =>
  z.object({
    to: buildRecipientSchema(t),
    // 0 is allowed on purpose — delegating 0 HP revokes an existing delegation.
    amount: buildAmountSchema({ max: maxHp, allowZero: true }, t)
  });

type DelegateFormValues = z.infer<ReturnType<typeof buildSchema>>;

export default function DelegateDialog({
  trigger,
  username,
  maxHp,
  defaultOpen
}: {
  trigger: ReactNode;
  username: string;
  /**
   * ★ MOVABLE HP, not effective (2026-08-13, map item 10). `netHp` — the
   * previous name and value passed here — includes HP delegated IN, which
   * cannot itself be re-delegated: it belongs to the delegator and vanishes
   * the moment they revoke it. Passing it let this dialog print a "Balance"
   * the account could not actually move and let Use-Max fill an amount the
   * chain was always going to refuse. Callers must pass `movableHp`
   * (`wallet-derived.ts`), not `netHp`.
   */
  maxHp: Big;
  /** See use-wallet-dialog.ts — set by lazy-wallet-dialog.tsx on first load. */
  defaultOpen?: boolean;
}) {
  const { t } = useTranslation('common_blog');
  const delegateMutation = useDelegateMutation();

  const schema = useMemo(() => buildSchema(maxHp, t), [maxHp, t]);
  const form = useForm<DelegateFormValues>({ resolver: zodResolver(schema), mode: 'onSubmit' });
  const { open, setOpen, onOpenChange } = useWalletDialog(form, defaultOpen);

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
      onOpenChange={onOpenChange}
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
        balanceLabel={`${t('wallet.dialogs.common.balance')}: ${maxHp.toFixed(3)}`}
        onUseMax={() => form.setValue('amount', maxHp.toNumber())}
        register={form.register('amount', { valueAsNumber: true })}
        error={form.formState.errors.amount?.message}
        testId="wallet-delegate-amount"
      />
    </WalletDialogShell>
  );
}
