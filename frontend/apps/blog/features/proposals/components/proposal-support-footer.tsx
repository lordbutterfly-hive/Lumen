'use client';

import { cn } from '@ui/lib/utils';
import TooltipContainer from '@ui/components/tooltip-container';
import { useTranslation } from '@/blog/i18n/client';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import DialogLogin from '@/blog/components/dialog-login';
import { formatHp } from '../lib/proposals-format';
import HeartIcon from './heart-icon';

interface Props {
  isLoggedIn: boolean;
  isSupported: boolean;
  /** The viewer's own votes couldn't be loaded — the toggle's state is unknown, not "not supported". */
  votesUnavailable: boolean;
  isPending: boolean;
  voteValueHp: number;
  onToggle: () => void;
}

/**
 * Card footer: heart + vote value on the left, real Support / Un-support toggle
 * on the right. Logged-out viewers get the app's real login dialog instead of a
 * dead button — clicking Support always goes somewhere.
 */
export default function ProposalSupportFooter({
  isLoggedIn,
  isSupported,
  votesUnavailable,
  isPending,
  voteValueHp,
  onToggle
}: Props) {
  const { t } = useTranslation('common_blog');
  const { user } = useUserClient();
  // A lite account has no Hive keys — the mutation backstop already refuses this
  // (use-proposal-vote-mutation.ts -> refuseIfLite), but the toggle used to render
  // fully enabled until clicked, with a brief optimistic "supported" flash before
  // the rollback (see that hook's onMutate for the corresponding fix).
  const isLiteBlocked = isLoggedIn && user.account_tier === 'lite';

  // Vote state unknown for a logged-in viewer: don't render a confident (possibly wrong)
  // "Support"/"Un-support" toggle — surface an honest "couldn't load your votes" note instead.
  const showIndeterminate = isLoggedIn && votesUnavailable;

  const button = (
    <button
      type="button"
      disabled={isPending || isLiteBlocked}
      onClick={isLoggedIn && !isLiteBlocked ? onToggle : undefined}
      data-testid="proposal-support-toggle"
      aria-pressed={isSupported}
      className={cn(
        'rounded-[10px] px-5 py-2.5 font-sans text-[13px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60',
        isSupported
          ? 'border border-[#c0392b] bg-[#c0392b] text-white hover:bg-[#96271b]'
          : 'border border-[#e4e6e9] bg-white text-[#3f4650] hover:bg-[#f6f7f8]'
      )}
    >
      {isPending
        ? t('proposals.card.support_pending')
        : isSupported
          ? t('proposals.card.unsupport')
          : t('proposals.card.support')}
    </button>
  );

  return (
    <div className="mt-4 flex items-center justify-between gap-4 border-t border-[#f1f3f5] pt-3.5">
      <span className="flex items-center gap-2 font-sans text-[12.5px] text-[#6b7280]">
        <HeartIcon filled={showIndeterminate ? false : isSupported} />
        {t('proposals.card.vote_value')}{' '}
        <strong className="tabular-nums text-[#2a2822]">{formatHp(voteValueHp)}</strong>
      </span>
      {showIndeterminate ? (
        <span
          className="font-sans text-[12.5px] italic text-[#9ca3af]"
          data-testid="proposal-support-unavailable"
        >
          {t('proposals.card.votes_unavailable')}
        </span>
      ) : isLiteBlocked ? (
        <TooltipContainer title={t('proposals.lite_cannot_vote')}>{button}</TooltipContainer>
      ) : isLoggedIn ? (
        button
      ) : (
        <DialogLogin>{button}</DialogLogin>
      )}
    </div>
  );
}
