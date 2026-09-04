'use client';

import { ReactNode, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import Big from 'big.js';
import { toast } from '@ui/components/hooks/use-toast';
import { handleError } from '@ui/lib/handle-error';
import { getAsset } from '@transaction/lib/utils';
import { Slider } from '@ui/components/slider';
import { useTranslation } from '@/blog/i18n/client';
import { usePowerDownMutation } from '../../hooks/use-power-mutations';
import WalletDialogShell from './shared/wallet-dialog-shell';
import AmountField from './shared/amount-field';
import { useWalletDialog } from './shared/use-wallet-dialog';
import { buildAmountSchema } from './shared/amount-schema';

const HIVE_VESTING_WITHDRAW_INTERVALS = 13;

const buildSchema = (maxHp: Big, t: (key: string, opts?: Record<string, unknown>) => string) =>
  z.object({
    amount: buildAmountSchema({ max: maxHp }, t)
  });

type PowerDownFormValues = z.infer<ReturnType<typeof buildSchema>>;

export default function PowerDownDialog({
  trigger,
  username,
  maxHp,
  defaultOpen
}: {
  trigger: ReactNode;
  username: string;
  /**
   * ★ MOVABLE HP, not effective (2026-08-09; renamed netHp -> maxHp
   * 2026-08-13, map item 10 rider). This prop already RECEIVED `movableHp`
   * from its caller but was still literally named `netHp` — the exact
   * mislabel that let the sibling Delegate dialog reintroduce this class of
   * bug. `maxHp` states what every caller must supply: the true ceiling for
   * whatever this dialog moves.
   */
  maxHp: Big;
  /** See use-wallet-dialog.ts — set by lazy-wallet-dialog.tsx on first load. */
  defaultOpen?: boolean;
}) {
  const { t } = useTranslation('common_blog');
  const powerDownMutation = usePowerDownMutation();

  const schema = useMemo(() => buildSchema(maxHp, t), [maxHp, t]);
  const form = useForm<PowerDownFormValues>({ resolver: zodResolver(schema), mode: 'onSubmit', defaultValues: { amount: 0 } });
  const { open, setOpen, onOpenChange } = useWalletDialog(form, defaultOpen);
  /**
   * ★ `Number.isFinite`, NOT `|| 0` (2026-08-13, A1 review W-4). `|| 0`
   * neutralises `NaN` (falsy) but NOT `Infinity`, which is truthy — and
   * `register('amount', { valueAsNumber: true })` turns a typed `1e999` into
   * exactly that. `new Big(Infinity)` THROWS (`[big.js] Invalid number`,
   * executed against the installed 6.2.2), and the throw is in the per-week
   * line BELOW, i.e. during RENDER, on KEYSTROKE — long before the schema
   * gets a chance to reject it at submit. There is no error.tsx under
   * app/wallet, so it takes the whole wallet page down rather than showing a
   * validation message. `Number.isFinite` covers Infinity, -Infinity, NaN and
   * undefined in one predicate, and feeds the controlled `<Slider>` below a
   * usable number as well.
   */
  const watchedAmount = form.watch('amount');
  const amount = Number.isFinite(watchedAmount) ? watchedAmount : 0;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const hp = await getAsset(values.amount.toString(), 'HIVE');
      await powerDownMutation.mutateAsync({ account: username, hp });
      toast({ title: t('wallet.dialogs.common.success_title'), description: t('wallet.staked.unstake'), variant: 'success' });
      setOpen(false);
      form.reset();
    } catch (error) {
      handleError(error, { method: 'walletPowerDown', params: values });
    }
  });

  return (
    <WalletDialogShell
      trigger={trigger}
      title={t('wallet.dialogs.power_down.title')}
      description={t('wallet.dialogs.power_down.description')}
      open={open}
      onOpenChange={onOpenChange}
      onSubmit={onSubmit}
      submitLabel={t('wallet.staked.unstake')}
      cancelLabel={t('wallet.dialogs.common.cancel')}
      isSubmitting={powerDownMutation.isPending}
    >
      <Slider
        dataTestId="wallet-power-down-slider"
        // ★ Controlled (map item 5(ii)). `defaultValue` made this Slider
        // uncontrolled, so `form.reset()` on a stale-form close/reopen (item
        // 5) or a click on the AmountField's own Use-Max below would leave
        // the thumb showing the old position while the form held a different
        // number. `value` keeps the thumb and the numeric field as one
        // source of truth in both directions.
        value={[amount]}
        max={maxHp.toNumber()}
        step={0.001}
        onValueChange={(value) => form.setValue('amount', value[0])}
      />
      {/* ★ Balance + Use-Max (map item 7). This dialog used to hand-roll a
          bare Input with no visible balance and no quick-fill, unlike every
          sibling dialog. The figure is deliberately labelled "Available to
          power down", not "Balance" — this is `movableHp`, which is smaller
          than the vesting-HP figure shown two rows up on the wallet page
          whenever the account has received delegations, and "Balance: X"
          next to a bigger number two lines above would read as a bug. */}
      <AmountField
        label={t('wallet.dialogs.common.amount')}
        currency="HIVE"
        balanceLabel={t('wallet.dialogs.power_down.available', { amount: maxHp.toFixed(3) })}
        onUseMax={() => form.setValue('amount', maxHp.toNumber())}
        register={form.register('amount', { valueAsNumber: true })}
        error={form.formState.errors.amount?.message}
        testId="wallet-power-down-amount"
      />
      <p className="text-caption tabular-nums text-ink-10">
        {t('wallet.dialogs.power_down.per_week', {
          amount: new Big(amount).div(HIVE_VESTING_WITHDRAW_INTERVALS).toFixed(3)
        })}
      </p>
    </WalletDialogShell>
  );
}
