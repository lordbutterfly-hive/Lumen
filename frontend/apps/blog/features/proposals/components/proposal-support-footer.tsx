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
  /**
   * ★ AN EXPIRED PROPOSAL CANNOT BE SUPPORTED (2026-08-10, v8 section 5). The toggle
   * rendered live and clickable on proposals whose funding window has closed, so the
   * card offered an action the chain will not accept. Voting on an expired proposal is
   * not an error the user should have to discover by trying it.
   */
  isExpired: boolean;
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
  isExpired,
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

  // The hover/focus -> "Remove vote" swap only promises an action that is actually
  // available right now — a supported-but-expired (or lite-blocked) proposal stays on
  // the plain "Supported" label instead of hinting at a removal the button won't perform.
  const canRemoveOnHover = isSupported && !isPending && !isLiteBlocked && !isExpired;

  const button = (
    <button
      type="button"
      disabled={isPending || isLiteBlocked || isExpired}
      onClick={isLoggedIn && !isLiteBlocked ? onToggle : undefined}
      data-testid="proposal-support-toggle"
      aria-pressed={isSupported}
      /**
       * ★★★ THE ACCESSIBLE NAME DOES NOT DEPEND ON HOVER (2026-08-11, item 21).
       * The visible label swaps to "Remove vote" only on `:hover`/`:focus-visible`
       * below, which is real for a sighted mouse/keyboard user but tells a screen
       * reader nothing — AT announces the ACCESSIBLE NAME, not a CSS pseudo-state.
       * This `aria-label` says the full thing ("Supported. Activate to remove your
       * vote…") unconditionally, so a screen-reader or switch-control user gets the
       * complete instruction on first encounter, with no dependency on triggering
       * hover/focus first. It still starts with "Supported" — the same word as the
       * visible resting label — so it satisfies WCAG 2.5.3 (Label in Name) for
       * speech-input users too.
       */
      aria-label={canRemoveOnHover ? t('proposals.card.remove_vote_aria') : undefined}
      className={cn(
        'group rounded-[10px] px-5 py-2.5 font-sans text-[13px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60',
        isSupported
          ? 'border border-[#e4e6e9] bg-white text-[#3f4650] hover:border-[#c0392b] hover:bg-[#fdf3f2] hover:text-[#c0392b] focus-visible:border-[#c0392b] focus-visible:bg-[#fdf3f2] focus-visible:text-[#c0392b]'
          : 'border border-[#e4e6e9] bg-white text-[#3f4650] hover:bg-[#f6f7f8]'
      )}
    >
      {isPending ? (
        t('proposals.card.support_pending')
      ) : isSupported ? (
        canRemoveOnHover ? (
          /**
           * ★★★ "SUPPORTED" IS NOT A WARNING (2026-08-11, fuckery list item 21). This
           * toggle used to render as a SOLID RED button labelled "Un-support" the
           * instant a reader supported a proposal — red is this app's ONE destructive
           * colour (delete, un-follow, block), so the normal, successful "you already
           * back this" state read as an error the whole time it was true. It is now
           * neutral/outline at rest, matching the not-yet-supported button, and only
           * hints at removal ("Remove vote") on hover OR keyboard focus — both
           * `group-hover:` and `group-focus-visible:` on each span below, so a
           * sighted keyboard-only reader (Tab, no mouse) sees the exact same
           * affordance a mouse user does before pressing anything.
           */
          <>
            <span aria-hidden="true" className="group-hover:hidden group-focus-visible:hidden">
              {t('proposals.card.supported')}
            </span>
            <span aria-hidden="true" className="hidden group-hover:inline group-focus-visible:inline">
              {t('proposals.card.remove_vote')}
            </span>
          </>
        ) : (
          t('proposals.card.supported')
        )
      ) : (
        t('proposals.card.support')
      )}
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
