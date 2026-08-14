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
import TooltipContainer from '@ui/components/tooltip-container';
import { useTranslation } from '@/blog/i18n/client';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import DialogLogin from '@/blog/components/dialog-login';
import { useCreateProposalMutation } from '../hooks/use-create-proposal-mutation';

// Real Hive protocol constant (HIVE_PROPOSAL_SUBJECT_MAX_LENGTH).
const SUBJECT_MAX_LENGTH = 80;
const MIN_START_DATE = dayjs().add(1, 'day').format('YYYY-MM-DD');

export default function NewProposalDialog({ children }: { children: ReactNode }) {
  const { t } = useTranslation('common_blog');
  const { user } = useUserClient();
  /**
   * ★ SAME DEFECT AS /witnesses (2026-08-11, class sweep). This branched render on
   * raw `user.isLoggedIn`, which cannot answer during SSR and reports "signed out"
   * on the client until `/api/users/me` returns — so a signed-in reader's trigger
   * button was wrapped in `DialogLogin` (opens the login modal instead of the real
   * new-proposal form) for up to several seconds after every page load. See
   * features/layouts/server-session.tsx.
   */
  const identity = useSessionIdentity();
  const mutation = useCreateProposalMutation();
  const [open, setOpen] = useState(false);
  const [receiver, setReceiver] = useState('');
  const [permlink, setPermlink] = useState('');
  const [subject, setSubject] = useState('');
  const [dailyPayHbd, setDailyPayHbd] = useState('');
  const [startDate, setStartDate] = useState(MIN_START_DATE);
  const [endDate, setEndDate] = useState(dayjs(MIN_START_DATE).add(60, 'day').format('YYYY-MM-DD'));

  if (!identity.isLoggedIn) {
    return <DialogLogin>{children}</DialogLogin>;
  }

  // Structural backstop for the same gate `proposals-main-header.tsx` already
  // applies at the trigger (real `disabled` + tooltip there). If this dialog is
  // ever mounted for a lite account some other way, it must not let the whole
  // form render fillable and client-side "valid" before refusing on Submit —
  // `children` has no click handler of its own outside `DialogTrigger`, so
  // simply not wrapping it in one already makes it inert.
  //
  // ★ FOLLOW-THROUGH FIX (2026-08-11). This used to read only `user.account_tier`,
  // which `useSessionIdentity` does not carry — on a cold tab with a session
  // cookie and no localStorage seed, `identity.isLoggedIn` (checked above)
  // answers true immediately while `user.account_tier` is still `undefined`, so
  // this check false-negatived to "not lite" and let a lite account reach the
  // real form below, fill it out, and hit a raw signer error on submit instead
  // of the friendly "lite accounts cannot vote" message. `account_tier` only
  // becomes trustworthy once `identity.clientAnswered` is true (same fetch that
  // answers `user.username` used throughout this form), so the safe default is
  // to treat the account as lite — i.e. keep showing this blocked state — until
  // the client has genuinely answered, matching list-variant.tsx's write-gate
  // precedent.
  //
  // ★ AND THE REASON MUST BE TRUE (2026-08-13, adversarial review S4). A failed
  // `/api/users/me` can never set `clientAnswered`, so this branch is reachable
  // permanently for a FULL Hive account — and it was telling that reader they need
  // to upgrade. The block is unchanged; the sentence is now the honest one.
  if (!identity.clientAnswered || user.account_tier === 'lite') {
    return (
      <TooltipContainer
        title={identity.sessionUnavailable ? t('proposals.session_unavailable') : t('proposals.lite_cannot_vote')}
      >
        {children}
      </TooltipContainer>
    );
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
          <p className="font-serif text-[13px] leading-[20px] text-ink-10">
            {t('proposals.new_dialog.fee_note')}
          </p>
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
