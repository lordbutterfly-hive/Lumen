'use client';

import { ReactNode, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import Big from 'big.js';
import { Input } from '@ui/components/input';
import { toast } from '@ui/components/hooks/use-toast';
import { handleError } from '@ui/lib/handle-error';
import { getAsset } from '@transaction/lib/utils';
import { useTranslation } from '@/blog/i18n/client';
import { useSendMutation } from '../../hooks/use-send-mutation';
import WalletDialogShell from './shared/wallet-dialog-shell';
import RecipientField from './shared/recipient-field';
import AmountField from './shared/amount-field';
import { FieldError } from './shared/field-error';
import { useWalletDialog } from './shared/use-wallet-dialog';
import { buildRecipientSchema } from './shared/recipient-schema';
import { buildAmountSchema } from './shared/amount-schema';

const buildSchema = (balance: Big, t: (key: string, opts?: Record<string, unknown>) => string) =>
  z.object({
    to: buildRecipientSchema(t),
    amount: buildAmountSchema({ max: balance }, t),
    // ★ 2048 is Hive's memo cap in BYTES, but `z.string().max()` counts
    // UTF-16 code units — a 2048-char Japanese/Arabic/Russian/Chinese memo
    // (all locales Lumen ships) can be ~2-3x that in bytes and the chain
    // would reject it after the client said it was fine. Do NOT change this
    // limit without owner input (map item 4's correctness rider) — flagging
    // only, not fixing the unit mismatch here.
    memo: z.string().max(2048, { message: t('wallet.dialogs.common.memo_too_long') }).optional()
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
  const sendMutation = useSendMutation();

  const schema = useMemo(() => buildSchema(balance, t), [balance, t]);
  const form = useForm<SendFormValues>({ resolver: zodResolver(schema), mode: 'onSubmit' });
  const { open, setOpen, onOpenChange } = useWalletDialog(form);

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
      onOpenChange={onOpenChange}
      onSubmit={onSubmit}
      submitLabel={t('wallet.dialogs.common.next')}
      cancelLabel={t('wallet.dialogs.common.cancel')}
      isSubmitting={sendMutation.isPending}
    >
      <div className="flex flex-col gap-1.5">
        <label className="text-caption font-medium text-ink-7">{t('wallet.dialogs.common.from')}</label>
        <Input disabled defaultValue={username} className="text-ink-7" />
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
        <label className="text-caption font-medium text-ink-7">{t('wallet.dialogs.common.memo')}</label>
        <Input {...form.register('memo')} placeholder={t('wallet.dialogs.common.memo')} />
        {/* ★ Was missing (map item 4/7). `.max(2048)` DOES enforce — RHF
            never calls onValid, so no mutation is attempted on an over-long
            memo — but with no FieldError element the Send button appeared to
            silently do nothing: no toast, no inline text, no explanation. */}
        <FieldError message={form.formState.errors.memo?.message} />
      </div>
    </WalletDialogShell>
  );
}
