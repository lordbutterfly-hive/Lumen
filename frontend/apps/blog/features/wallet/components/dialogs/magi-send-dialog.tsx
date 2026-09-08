'use client';

/**
 * Send HBD, HIVE or BTC from this Magi account to another Magi account.
 *
 * Altera's send (QuickSend / TransferOptions), in the wallet's own dialog
 * grammar: the same shell, amount field and schemas the Hive tab's Send uses.
 * The recipient is whatever Altera accepts — a Hive name, an 0x address, a
 * Bitcoin address, or a qualified `hive:` / `did:pkh:` id (lib/magi-ops.ts
 * parseMagiRecipient) — and a Hive name is checked to exist before the form
 * submits, exactly as the Hive Send does (shared/recipient-schema.ts), because
 * the ledger credits ANY string and a typo would strand the funds.
 *
 * Signing is per login (lib/magi-rails.ts): active key, EVM wallet or Bitcoin
 * wallet. The dialog resolves only on a terminal chain status.
 */
import { ReactNode, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import Big from 'big.js';
import { Input } from '@ui/components/input';
import { toast } from '@ui/components/hooks/use-toast';
import { handleError } from '@ui/lib/handle-error';
import { useTranslation } from '@/blog/i18n/client';
import { fetchAccountExists } from '@/blog/lib/chain-fetch';
import { toMagiAccountId } from '@/blog/lib/lite/wallet/magi-assets';
import type { TokenAccount } from '@/blog/features/creator-tokens/live/use-token-accounts';
import { useMagiSendMutation } from '../../hooks/use-magi-send-mutation';
import { btcToSats, formatMagiAmount, parseMagiRecipient, type MagiSendAsset } from '../../lib/magi-ops';
import WalletDialogShell from './shared/wallet-dialog-shell';
import AmountField from './shared/amount-field';
import { FieldError } from './shared/field-error';
import { useWalletDialog } from './shared/use-wallet-dialog';
import { buildAmountSchema } from './shared/amount-schema';

type TFn = (key: string, opts?: Record<string, unknown>) => string;

/** BTC carries eight decimals; the shared schema is built for Hive's three. */
const buildBtcAmountSchema = (max: Big, t: TFn) =>
  z
    .number({ invalid_type_error: t('wallet.dialogs.common.amount_invalid') })
    .positive({ message: t('wallet.dialogs.common.amount_positive') })
    .refine((v) => new Big(String(v)).round(8, 0).eq(new Big(String(v))), { message: t('wallet.dialogs.common.amount_precision') })
    .refine((v) => new Big(String(v)).lte(max), { message: t('wallet.dialogs.common.amount_exceeds_balance') });

const buildRecipient = (selfId: string, t: TFn) =>
  z
    .string({ message: t('wallet.dialogs.common.recipient_required') })
    .min(1, { message: t('wallet.dialogs.common.recipient_required') })
    .superRefine(async (value, ctx) => {
      const parsed = parseMagiRecipient(value);
      if (!parsed) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: t('wallet.magi.send.recipient_invalid') });
        return;
      }
      if (parsed.id === selfId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: t('wallet.magi.send.recipient_self') });
        return;
      }
      if (parsed.kind !== 'hive' || typeof window === 'undefined') return;
      try {
        const result = await fetchAccountExists(parsed.hiveName ?? '');
        if (result.status === 'api_error') {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: t('wallet.dialogs.common.recipient_check_failed') });
        } else if (result.status !== 'exists') {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: t('wallet.dialogs.common.recipient_not_found') });
        }
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: t('wallet.dialogs.common.recipient_check_failed') });
      }
    });

const buildSchema = (asset: MagiSendAsset, balance: Big, selfId: string, t: TFn) =>
  z.object({
    to: buildRecipient(selfId, t),
    amount: asset === 'BTC' ? buildBtcAmountSchema(balance, t) : buildAmountSchema({ max: balance }, t),
    memo: z.string().max(2048, { message: t('wallet.dialogs.common.memo_too_long') }).optional()
  });

type SendFormValues = z.infer<ReturnType<typeof buildSchema>>;

export default function MagiSendDialog({
  trigger,
  account,
  asset,
  balance,
  defaultOpen
}: {
  trigger: ReactNode;
  account: TokenAccount;
  asset: MagiSendAsset;
  /** Whole units: HBD/HIVE with three decimals, BTC with eight. */
  balance: Big;
  /** See use-wallet-dialog.ts; set by lazy-wallet-dialog.tsx on first load. */
  defaultOpen?: boolean;
}) {
  const { t } = useTranslation('common_blog');
  const selfId = toMagiAccountId(account.id);
  const send = useMagiSendMutation();

  const schema = useMemo(() => buildSchema(asset, balance, selfId, t), [asset, balance, selfId, t]);
  const form = useForm<SendFormValues>({ resolver: zodResolver(schema), mode: 'onSubmit' });
  const { open, setOpen, onOpenChange } = useWalletDialog(form, defaultOpen);

  const typed = form.watch('to');
  const resolved = typed ? parseMagiRecipient(typed) : null;

  const onSubmit = form.handleSubmit(async (values) => {
    const to = parseMagiRecipient(values.to);
    if (!to) return;
    const amount = asset === 'BTC' ? btcToSats(String(values.amount)) : formatMagiAmount(String(values.amount));
    const shown = asset === 'BTC' ? new Big(String(values.amount)).toFixed(8) : amount;
    try {
      const result = await send.mutateAsync({ account, asset, to: to.id, amount, memo: asset === 'BTC' ? undefined : values.memo });
      if (result.status === 'confirmed') {
        toast({
          title: t('wallet.magi.send.success_title'),
          description: t('wallet.magi.send.success_body', { amount: shown, asset, to: to.id, id: result.id }),
          variant: 'success'
        });
      } else {
        toast({
          title: t('wallet.magi.send.unconfirmed_title'),
          description: t('wallet.magi.send.unconfirmed_body', { id: result.id })
        });
      }
      setOpen(false);
      form.reset();
    } catch (error) {
      handleError(error, { method: 'magiSend', params: { asset, to: to.id, amount } });
    }
  });

  const decimals = asset === 'BTC' ? 8 : 3;

  return (
    <WalletDialogShell
      trigger={trigger}
      title={t('wallet.magi.send.title', { asset })}
      description={t('wallet.magi.send.description', { asset })}
      open={open}
      onOpenChange={onOpenChange}
      onSubmit={onSubmit}
      submitLabel={t('wallet.magi.send.submit')}
      cancelLabel={t('wallet.dialogs.common.cancel')}
      isSubmitting={send.isPending}
    >
      <div className="flex flex-col gap-1.5">
        <label className="text-caption font-medium text-ink-7">{t('wallet.dialogs.common.from')}</label>
        <Input disabled defaultValue={selfId} className="font-mono text-ink-7" />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="magi-send-to" className="text-caption font-medium text-ink-7">
          {t('wallet.magi.send.recipient')}
        </label>
        <Input
          id="magi-send-to"
          placeholder={t('wallet.magi.send.recipient_hint')}
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          data-testid="magi-send-to"
          {...form.register('to')}
        />
        {resolved && !form.formState.errors.to ? (
          <p className="break-all font-mono text-caption text-ink-10" data-testid="magi-send-resolved">
            {t('wallet.magi.send.recipient_resolved', { id: resolved.id })}
          </p>
        ) : null}
        <FieldError message={form.formState.errors.to?.message} />
      </div>
      <AmountField
        label={t('wallet.dialogs.common.amount')}
        currency={asset}
        balanceLabel={`${t('wallet.dialogs.common.balance')}: ${balance.toFixed(decimals)}`}
        onUseMax={() => form.setValue('amount', balance.toNumber())}
        register={form.register('amount', { valueAsNumber: true })}
        error={form.formState.errors.amount?.message}
        testId="magi-send-amount"
      />
      {asset !== 'BTC' ? (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="magi-send-memo" className="text-caption font-medium text-ink-7">
            {t('wallet.magi.send.memo')}
          </label>
          <Input id="magi-send-memo" data-testid="magi-send-memo" {...form.register('memo')} />
          <FieldError message={form.formState.errors.memo?.message} />
        </div>
      ) : null}
      <p className="text-caption text-ink-10" data-testid="magi-send-note">
        {send.phase
          ? t(`wallet.magi.phase.${send.phase}`)
          : account.kind === 'hive'
            ? t('wallet.magi.send.note_hive')
            : t('wallet.magi.send.note_wallet')}
      </p>
    </WalletDialogShell>
  );
}
