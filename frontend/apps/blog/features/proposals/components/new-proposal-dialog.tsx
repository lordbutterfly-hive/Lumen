'use client';

import { ReactNode, useState } from 'react';
import dayjs from 'dayjs';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input
} from '@hive/ui';
import { useTranslation } from '@/blog/i18n/client';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import DialogLogin from '@/blog/components/dialog-login';
import { useCreateProposalMutation } from '../hooks/use-create-proposal-mutation';

// Real Hive protocol constant (HIVE_PROPOSAL_SUBJECT_MAX_LENGTH).
const SUBJECT_MAX_LENGTH = 80;
const MIN_START_DATE = dayjs().add(1, 'day').format('YYYY-MM-DD');

export default function NewProposalDialog({ children }: { children: ReactNode }) {
  const { t } = useTranslation('common_blog');
  const { user } = useUserClient();
  const mutation = useCreateProposalMutation();
  const [open, setOpen] = useState(false);
  const [receiver, setReceiver] = useState('');
  const [permlink, setPermlink] = useState('');
  const [subject, setSubject] = useState('');
  const [dailyPayHbd, setDailyPayHbd] = useState('');
  const [startDate, setStartDate] = useState(MIN_START_DATE);
  const [endDate, setEndDate] = useState(dayjs(MIN_START_DATE).add(60, 'day').format('YYYY-MM-DD'));

  if (!user.isLoggedIn) {
    return <DialogLogin>{children}</DialogLogin>;
  }

  const receiverValue = receiver.trim() || user.username;
  const isValid =
    permlink.trim().length > 0 &&
    subject.trim().length > 0 &&
    subject.trim().length <= SUBJECT_MAX_LENGTH &&
    Number(dailyPayHbd) > 0 &&
    dayjs(startDate).isValid() &&
    dayjs(endDate).isValid() &&
    dayjs(endDate).isAfter(dayjs(startDate));

  const handleSubmit = () => {
    mutation.mutate(
      {
        creator: user.username,
        receiver: receiverValue,
        permlink: permlink.trim(),
        subject: subject.trim(),
        dailyPayHbd,
        startDate,
        endDate
      },
      { onSuccess: () => setOpen(false) }
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="max-w-[480px]" data-testid="new-proposal-dialog">
        <DialogHeader>
          <DialogTitle>{t('proposals.new_dialog.title')}</DialogTitle>
          <DialogDescription>{t('proposals.new_dialog.description')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3.5">
          <label className="flex flex-col gap-1.5 text-sm">
            {t('proposals.new_dialog.permlink_label')}
            <Input
              value={permlink}
              onChange={(e) => setPermlink(e.target.value)}
              placeholder={t('proposals.new_dialog.permlink_placeholder')}
              data-testid="new-proposal-permlink"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            {t('proposals.new_dialog.subject_label')}
            <Input
              value={subject}
              maxLength={SUBJECT_MAX_LENGTH}
              onChange={(e) => setSubject(e.target.value)}
              placeholder={t('proposals.new_dialog.subject_placeholder')}
              data-testid="new-proposal-subject"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            {t('proposals.new_dialog.receiver_label')}
            <Input
              value={receiver}
              onChange={(e) => setReceiver(e.target.value.trim().toLowerCase())}
              placeholder={user.username}
              maxLength={16}
              data-testid="new-proposal-receiver"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            {t('proposals.new_dialog.daily_pay_label')}
            <Input
              type="number"
              min="0"
              step="0.001"
              value={dailyPayHbd}
              onChange={(e) => setDailyPayHbd(e.target.value)}
              placeholder="100.000"
              data-testid="new-proposal-daily-pay"
            />
          </label>
          <div className="flex gap-3">
            <label className="flex flex-1 flex-col gap-1.5 text-sm">
              {t('proposals.new_dialog.start_date_label')}
              <Input
                type="date"
                min={MIN_START_DATE}
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                data-testid="new-proposal-start-date"
              />
            </label>
            <label className="flex flex-1 flex-col gap-1.5 text-sm">
              {t('proposals.new_dialog.end_date_label')}
              <Input
                type="date"
                min={startDate}
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                data-testid="new-proposal-end-date"
              />
            </label>
          </div>
          <p className="font-serif text-[12.5px] leading-normal text-[#6b7280]">{t('proposals.new_dialog.fee_note')}</p>
        </div>

        <DialogFooter>
          <Button
            onClick={handleSubmit}
            disabled={!isValid || mutation.isLoading}
            data-testid="new-proposal-submit"
          >
            {mutation.isLoading ? t('proposals.new_dialog.submitting') : t('proposals.new_dialog.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
