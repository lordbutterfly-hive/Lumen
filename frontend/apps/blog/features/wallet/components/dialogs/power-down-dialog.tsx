'use client';

import { ReactNode, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import Big from 'big.js';
import { toast } from '@ui/components/hooks/use-toast';
import { handleError } from '@ui/lib/handle-error';
import { getAsset } from '@transaction/lib/utils';
import { Slider } from '@ui/components/slider';
import { Input } from '@ui/components/input';
import { useTranslation } from '@/blog/i18n/client';
import { usePowerDownMutation } from '../../hooks/use-power-mutations';
import WalletDialogShell from './shared/wallet-dialog-shell';
import { FieldError } from './shared/field-error';

const HIVE_VESTING_WITHDRAW_INTERVALS = 13;

const buildSchema = (maxHp: Big, t: (key: string, opts?: Record<string, unknown>) => string) =>
  z.object({
    amount: z
      .number({ message: t('wallet.dialogs.common.amount_positive') })
      .positive({ message: t('wallet.dialogs.common.amount_positive') })
      .refine((value) => value <= maxHp.toNumber(), { message: t('wallet.dialogs.common.amount_exceeds_balance') })
  });

type PowerDownFormValues = z.infer<ReturnType<typeof buildSchema>>;

export default function PowerDownDialog({
  trigger,
  username,
  netHp
}: {
  trigger: ReactNode;
  username: string;
  netHp: Big;
}) {
  const { t } = useTranslation('common_blog');
  const [open, setOpen] = useState(false);
  const powerDownMutation = usePowerDownMutation();

  const schema = useMemo(() => buildSchema(netHp, t), [netHp, t]);
  const form = useForm<PowerDownFormValues>({ resolver: zodResolver(schema), mode: 'onSubmit', defaultValues: { amount: 0 } });
  const amount = form.watch('amount') || 0;

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
      onOpenChange={setOpen}
      onSubmit={onSubmit}
      submitLabel={t('wallet.staked.unstake')}
      cancelLabel={t('wallet.dialogs.common.cancel')}
      isSubmitting={powerDownMutation.isPending}
    >
      <Slider
        dataTestId="wallet-power-down-slider"
        defaultValue={[0]}
        max={netHp.toNumber()}
        step={0.001}
        onValueChange={(value) => form.setValue('amount', value[0])}
      />
      <div className="flex items-center gap-3">
        <Input
          {...form.register('amount', { valueAsNumber: true })}
          type="number"
          step="any"
          className="tabular-nums"
        />
        <span className="text-[13px] font-semibold text-[#3f4650]">HIVE</span>
      </div>
      <FieldError message={form.formState.errors.amount?.message} />
      <p className="text-[12.5px] text-[#6b7280]">
        {t('wallet.dialogs.power_down.per_week', {
          amount: new Big(amount).div(HIVE_VESTING_WITHDRAW_INTERVALS).toFixed(3)
        })}
      </p>
    </WalletDialogShell>
  );
}
