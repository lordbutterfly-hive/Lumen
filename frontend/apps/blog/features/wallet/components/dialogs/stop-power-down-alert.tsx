'use client';

import { ReactNode } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from '@ui/components/alert-dialog';
import { CircleSpinner } from 'react-spinners-kit';
import { toast } from '@ui/components/hooks/use-toast';
import { handleError } from '@ui/lib/handle-error';
import { useTranslation } from '@/blog/i18n/client';
import { useCancelPowerDownMutation } from '../../hooks/use-power-mutations';

/**
 * "STOP" on the power-down notice. Real op: withdraw_vesting_operation with
 * 0 HP, which cancels the active schedule (keeps whatever is already staked).
 */
export default function StopPowerDownAlert({ trigger, username }: { trigger: ReactNode; username: string }) {
  const { t } = useTranslation('common_blog');
  const cancelMutation = useCancelPowerDownMutation();

  const handleConfirm = async () => {
    try {
      await cancelMutation.mutateAsync({ account: username });
      toast({
        title: t('wallet.dialogs.common.success_title'),
        description: t('wallet.dialogs.stop_power_down.title'),
        variant: 'success'
      });
    } catch (error) {
      handleError(error, { method: 'walletStopPowerDown', params: { username } });
    }
  };

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent className="rounded-[18px] font-sans">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-[#161511]">{t('wallet.dialogs.stop_power_down.title')}</AlertDialogTitle>
          <AlertDialogDescription className="text-[#6b7280]">
            {t('wallet.dialogs.stop_power_down.description')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('wallet.dialogs.common.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={cancelMutation.isPending}
            className="bg-[#c0392b] text-white hover:bg-[#96271b]"
          >
            {cancelMutation.isPending ? (
              <CircleSpinner loading size={16} color="#fff" />
            ) : (
              t('wallet.dialogs.stop_power_down.confirm')
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
