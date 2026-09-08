'use client';

/**
 * Deposit HIVE or HBD from the Hive account onto Magi.
 *
 * Altera's deposit button, in Lumen's clothes: the mechanism (a `transfer` to the
 * gateway with a `to=` memo, active key) is Altera's, see
 * hooks/use-magi-deposit-mutation.ts; the surface is the wallet's own dialog shell,
 * amount field and schema (dialogs/shared/*), the same ones Send and Savings use.
 */
import { ReactNode, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import Big from 'big.js';
import { toast } from '@ui/components/hooks/use-toast';
import { handleError } from '@ui/lib/handle-error';
import { useTranslation } from '@/blog/i18n/client';
import { MAGI_GATEWAY_ACCOUNT, useMagiDepositMutation } from '../../hooks/use-magi-deposit-mutation';
import { useMagiL1Balances } from '../../hooks/use-magi-l1-balances';
import WalletDialogShell from './shared/wallet-dialog-shell';
import AmountField from './shared/amount-field';
import { useWalletDialog } from './shared/use-wallet-dialog';
import { buildAmountSchema } from './shared/amount-schema';

const ZERO = new Big(0);

const buildSchema = (balance: Big, t: (key: string, opts?: Record<string, unknown>) => string) =>
  z.object({ amount: buildAmountSchema({ max: balance }, t) });

type DepositFormValues = z.infer<ReturnType<typeof buildSchema>>;

type Currency = 'HIVE' | 'HBD';

export default function MagiDepositDialog({
  trigger,
  username,
  defaultOpen
}: {
  trigger: ReactNode;
  username: string;
  /** See use-wallet-dialog.ts; set by lazy-wallet-dialog.tsx on first load. */
  defaultOpen?: boolean;
}) {
  const { t } = useTranslation('common_blog');
  const [currency, setCurrency] = useState<Currency>('HBD');
  const { balances, isLoading: balancesLoading } = useMagiL1Balances(username);
  const balance = balances ? (currency === 'HIVE' ? balances.liquidHive : balances.liquidHbd) : ZERO;
  const deposit = useMagiDepositMutation();

  const schema = useMemo(() => buildSchema(balance, t), [balance, t]);
  const form = useForm<DepositFormValues>({ resolver: zodResolver(schema), mode: 'onSubmit' });
  const { open, setOpen, onOpenChange } = useWalletDialog(form, defaultOpen);

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const amount = new Big(values.amount).toFixed(3);
      await deposit.mutateAsync({ username, currency, amount });
      toast({
        title: t('wallet.magi.deposit.success_title'),
        description: t('wallet.magi.deposit.success_body', { amount, currency }),
        variant: 'success'
      });
      setOpen(false);
      form.reset();
    } catch (error) {
      handleError(error, { method: 'magiDeposit', params: { currency, ...values } });
    }
  });

  const pick = (next: Currency) => {
    setCurrency(next);
    form.resetField('amount');
  };

  return (
    <WalletDialogShell
      trigger={trigger}
      title={t('wallet.magi.deposit.title')}
      description={t('wallet.magi.deposit.description', { gateway: MAGI_GATEWAY_ACCOUNT })}
      open={open}
      onOpenChange={onOpenChange}
      onSubmit={onSubmit}
      submitLabel={t('wallet.magi.deposit.submit')}
      cancelLabel={t('wallet.dialogs.common.cancel')}
      isSubmitting={deposit.isPending}
      submitDisabled={balancesLoading || !balances}
    >
      <div className="flex flex-col gap-1.5">
        <span className="text-caption font-medium text-ink-7">{t('wallet.magi.deposit.asset')}</span>
        <div className="flex gap-2" role="radiogroup" aria-label={t('wallet.magi.deposit.asset')}>
          {(['HBD', 'HIVE'] as const).map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={currency === c}
              onClick={() => pick(c)}
              data-testid={`magi-deposit-asset-${c.toLowerCase()}`}
              className={`rounded-control border px-4 py-2 text-caption font-medium transition-colors ${
                currency === c ? 'border-line-brand-10 bg-surface-brand-4 text-ink-brand-4' : 'border-line-11 bg-surface-1 text-ink-7 hover:bg-surface-16'
              }`}
            >
              {c}
            </button>
          ))}
        </div>
      </div>
      <AmountField
        label={t('wallet.dialogs.common.amount')}
        currency={currency}
        balanceLabel={`${t('wallet.dialogs.common.balance')}: ${balancesLoading || !balances ? '…' : balance.toFixed(3)}`}
        onUseMax={() => form.setValue('amount', balance.toNumber())}
        register={form.register('amount', { valueAsNumber: true })}
        error={form.formState.errors.amount?.message}
        testId="magi-deposit-amount"
      />
      <p className="text-caption text-ink-10">{t('wallet.magi.deposit.note')}</p>
    </WalletDialogShell>
  );
}
