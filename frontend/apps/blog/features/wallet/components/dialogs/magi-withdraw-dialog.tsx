'use client';

/**
 * Withdraw from Magi: HBD / HIVE to a Hive account, or BTC to a Bitcoin address.
 *
 * Altera's withdraw flow (Withdraw.svelte + vscOperations/withdrawal.ts, and
 * the BTC-mainnet unmap at sendUtils.ts:789), in the wallet's dialog grammar.
 * Two of Altera's guards are kept because each one prevents a stranding:
 *  - the Hive recipient must exist (shared/recipient-schema.ts: a withdrawal to
 *    an unregistered name is paid out by the gateway to nobody);
 *  - a Bitcoin recipient must not be the deposit address Magi generated for
 *    this account (Altera sendUtils.ts:565-580 assertBtcRecipientAllowed: that
 *    address is bridge-controlled, so the coins would return to the vault).
 */
import { ReactNode, useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import Big from 'big.js';
import { Input } from '@ui/components/input';
import { toast } from '@ui/components/hooks/use-toast';
import { handleError } from '@ui/lib/handle-error';
import { csrfHeaderName } from '@smart-signer/lib/csrf-protection';
import { useTranslation } from '@/blog/i18n/client';
import { toMagiAccountId } from '@/blog/lib/lite/wallet/magi-assets';
import type { TokenAccount } from '@/blog/features/creator-tokens/live/use-token-accounts';
import { useMagiWithdrawMutation } from '../../hooks/use-magi-withdraw-mutation';
import { btcToSats, formatMagiAmount, type MagiSendAsset } from '../../lib/magi-ops';
import WalletDialogShell from './shared/wallet-dialog-shell';
import AmountField from './shared/amount-field';
import RecipientPicker, { type RecipientResolution } from './shared/recipient-picker';
import { INPUT_CLASS } from './shared/field-classes';
import { useWalletDialog } from './shared/use-wallet-dialog';
import { buildAmountSchema } from './shared/amount-schema';
import { buildBtcAddressSchema, buildRecipientSchema } from './shared/recipient-schema';

type TFn = (key: string, opts?: Record<string, unknown>) => string;

const buildBtcAmountSchema = (max: Big, t: TFn) =>
  z
    .number({ invalid_type_error: t('wallet.dialogs.common.amount_invalid') })
    .positive({ message: t('wallet.dialogs.common.amount_positive') })
    .refine((v) => new Big(String(v)).round(8, 0).eq(new Big(String(v))), { message: t('wallet.dialogs.common.amount_precision') })
    .refine((v) => new Big(String(v)).lte(max), { message: t('wallet.dialogs.common.amount_exceeds_balance') });

const buildSchema = (asset: MagiSendAsset, balance: Big, ownDeposit: string | null, t: TFn) =>
  z.object({
    to: asset === 'BTC' ? buildBtcAddressSchema(t, { ownDeposit }) : buildRecipientSchema(t),
    amount: asset === 'BTC' ? buildBtcAmountSchema(balance, t) : buildAmountSchema({ max: balance }, t)
  });

type WithdrawFormValues = z.infer<ReturnType<typeof buildSchema>>;

/** The deposit address Magi minted for this account, if the bot answers; null blocks nothing (Altera's no-op rule). */
async function ownBtcDepositAddress(account: string): Promise<string | null> {
  try {
    const res = await fetch('/api/magi/btc-deposit-address', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [csrfHeaderName]: '1' },
      body: JSON.stringify({ account }),
      cache: 'no-store'
    });
    const json = (await res.json().catch(() => null)) as { address?: unknown } | null;
    return res.ok && typeof json?.address === 'string' ? json.address : null;
  } catch {
    return null;
  }
}

export default function MagiWithdrawDialog({
  trigger,
  account,
  balances,
  defaultOpen
}: {
  trigger: ReactNode;
  account: TokenAccount;
  /** Whole units per asset; BTC absent when the mapping contract is not on this build. */
  balances: { HBD: Big; HIVE: Big; BTC?: Big };
  defaultOpen?: boolean;
}) {
  const { t } = useTranslation('common_blog');
  const selfId = toMagiAccountId(account.id);
  const withdraw = useMagiWithdrawMutation();
  const [asset, setAsset] = useState<MagiSendAsset>('HBD');
  const [ownDeposit, setOwnDeposit] = useState<string | null>(null);
  const balance = useMemo(
    () => (asset === 'BTC' ? (balances.BTC ?? new Big(0)) : balances[asset]),
    [asset, balances]
  );
  const assets: MagiSendAsset[] = balances.BTC !== undefined ? ['HBD', 'HIVE', 'BTC'] : ['HBD', 'HIVE'];

  const schema = useMemo(() => buildSchema(asset, balance, ownDeposit, t), [asset, balance, ownDeposit, t]);
  const form = useForm<WithdrawFormValues>({
    resolver: zodResolver(schema),
    mode: 'onSubmit',
    defaultValues: { to: account.kind === 'hive' ? account.id : '' }
  });
  const { open, setOpen, onOpenChange } = useWalletDialog(form, defaultOpen);
  const [recipient, setRecipient] = useState<RecipientResolution>({ status: 'idle' });
  const toValue = form.watch('to');

  useEffect(() => {
    if (!open || asset !== 'BTC' || ownDeposit !== null) return;
    let cancelled = false;
    void ownBtcDepositAddress(selfId).then((addr) => {
      if (!cancelled && addr) setOwnDeposit(addr);
    });
    return () => {
      cancelled = true;
    };
  }, [open, asset, ownDeposit, selfId]);

  const pick = (next: MagiSendAsset) => {
    setAsset(next);
    form.resetField('amount');
    form.setValue('to', next === 'BTC' ? '' : account.kind === 'hive' ? account.id : '');
  };

  const onSubmit = form.handleSubmit(async (values) => {
    const to = asset === 'BTC' ? values.to.trim() : `hive:${values.to.trim().toLowerCase()}`;
    const amount = asset === 'BTC' ? btcToSats(String(values.amount)) : formatMagiAmount(String(values.amount));
    const shown = asset === 'BTC' ? new Big(String(values.amount)).toFixed(8) : amount;
    try {
      const result = await withdraw.mutateAsync({ account, asset, to, amount });
      if (result.status === 'confirmed') {
        toast({
          title: t('wallet.magi.withdraw.success_title'),
          description: t('wallet.magi.withdraw.success_body', { amount: shown, asset, to, id: result.id }),
          variant: 'success'
        });
      } else {
        toast({ title: t('wallet.magi.send.unconfirmed_title'), description: t('wallet.magi.send.unconfirmed_body', { id: result.id }) });
      }
      setOpen(false);
      form.reset();
    } catch (error) {
      handleError(error, { method: 'magiWithdraw', params: { asset, to, amount } });
    }
  });

  const decimals = asset === 'BTC' ? 8 : 3;

  return (
    <WalletDialogShell
      trigger={trigger}
      title={t('wallet.magi.withdraw.title')}
      description={t('wallet.magi.withdraw.description')}
      open={open}
      onOpenChange={onOpenChange}
      onSubmit={onSubmit}
      submitLabel={t('wallet.magi.withdraw.submit')}
      cancelLabel={t('wallet.dialogs.common.cancel')}
      isSubmitting={withdraw.isPending}
      submitDisabled={recipient.status !== 'ok'}
    >
      <div className="flex flex-col gap-1.5">
        <span className="text-caption font-medium text-ink-7">{t('wallet.magi.withdraw.asset')}</span>
        <div className="flex gap-2" role="radiogroup" aria-label={t('wallet.magi.withdraw.asset')}>
          {assets.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={asset === c}
              onClick={() => pick(c)}
              data-testid={`magi-withdraw-asset-${c.toLowerCase()}`}
              className={`rounded-control border px-4 py-2 text-caption font-medium transition-colors ${
                asset === c ? 'border-line-brand-10 bg-surface-brand-4 text-ink-brand-4' : 'border-line-11 bg-surface-1 text-ink-7 hover:bg-surface-16'
              }`}
            >
              {c}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="text-caption font-medium text-ink-7">{t('wallet.dialogs.common.from')}</label>
        <Input disabled defaultValue={selfId} className={`${INPUT_CLASS} font-mono text-ink-7`} />
      </div>
      <RecipientPicker
        mode={asset === 'BTC' ? 'btc' : 'hive'}
        label={asset === 'BTC' ? t('wallet.magi.withdraw.to_btc') : t('wallet.magi.withdraw.to_hive')}
        register={form.register('to')}
        value={toValue}
        onPick={(name) => form.setValue('to', name, { shouldValidate: true, shouldDirty: true })}
        onResolved={setRecipient}
        error={form.formState.errors.to?.message}
        testId="magi-withdraw-to"
      />
      <AmountField
        label={t('wallet.dialogs.common.amount')}
        currency={asset}
        balanceLabel={`${t('wallet.dialogs.common.balance')}: ${balance.toFixed(decimals)}`}
        onUseMax={() => form.setValue('amount', balance.toNumber())}
        register={form.register('amount', { valueAsNumber: true })}
        error={form.formState.errors.amount?.message}
        testId="magi-withdraw-amount"
      />
      <p className="text-caption text-ink-10" data-testid="magi-withdraw-note">
        {withdraw.phase ? t(`wallet.magi.phase.${withdraw.phase}`) : asset === 'BTC' ? t('wallet.magi.withdraw.note_btc') : t('wallet.magi.withdraw.note_hive')}
      </p>
    </WalletDialogShell>
  );
}
