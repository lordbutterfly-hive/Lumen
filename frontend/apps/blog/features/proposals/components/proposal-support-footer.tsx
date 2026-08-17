'use client';

import { cn } from '@ui/lib/utils';
import TooltipContainer from '@ui/components/tooltip-container';
import { Icons } from '@ui/components/icons';
import { useTranslation } from '@/blog/i18n/client';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import DialogLogin from '@/blog/components/dialog-login';
import { formatHp, formatHpCompact } from '../lib/proposals-format';

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
  /** Still fetching. Distinct from unavailable: nothing has failed yet. */
  votesPending: boolean;
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
  votesPending,
  isPending,
  voteValueHp,
  onToggle
}: Props) {
  const { t } = useTranslation('common_blog');
  const { user } = useUserClient();
  const identity = useSessionIdentity();
  // A lite account has no Hive keys — the mutation backstop already refuses this
  // (use-proposal-vote-mutation.ts -> refuseIfLite), but the toggle used to render
  // fully enabled until clicked, with a brief optimistic "supported" flash before
  // the rollback (see that hook's onMutate for the corresponding fix).
  //
  // ★ MIXED SOURCES WERE THE BUG (2026-08-11). `isLoggedIn` arrives as a prop
  // derived from `useSessionIdentity()`, which answers instantly from the server
  // cookie. `user.account_tier` comes from the client query, which does not — it
  // is `undefined` until `/api/users/me` returns. So the gate opened while the
  // tier was still unknown, `isLiteBlocked` computed false, and a lite account
  // got a fully enabled Support button for that window. That is the same
  // follow-through error found in wallet-right-rail, set-proxy-dialog and
  // new-proposal-dialog today: the gate was moved to `identity`, the fields it
  // depends on were left behind.
  //
  // `!identity.clientAnswered` treats the account as blocked until the client
  // genuinely answers — the safe direction, because the cost of being wrong is a
  // briefly-disabled button rather than a lite user clicking a vote they cannot
  // sign. Same precedent as account-lists/list-variant.tsx's write gate.
  const isLiteBlocked = isLoggedIn && (!identity.clientAnswered || user.account_tier === 'lite');

  // Vote state unknown for a logged-in viewer: don't render a confident (possibly wrong)
  // "Support"/"Un-support" toggle — surface an honest "couldn't load your votes" note instead.
  //
  // ★ PENDING IS NOT UNAVAILABLE (2026-08-17). `votesUnavailable` used to be true
  // while the fetch was merely in flight, so the ordinary healthy path announced a
  // failure to every signed-in reader on every visit. Both states still refuse to
  // render a confident toggle — that part was right — but only a genuine error is
  // allowed to SAY anything failed.
  const showIndeterminate = isLoggedIn && (votesUnavailable || votesPending);

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
        'group rounded-[10px] px-5 py-2.5 font-sans text-[13px] leading-[20px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60',
        isSupported
          ? 'border border-line-11 bg-surface-1 text-ink-7 hover:border-line-brand-10 hover:bg-surface-brand-1 hover:text-ink-brand-6 focus-visible:border-line-brand-10 focus-visible:bg-surface-brand-1 focus-visible:text-ink-brand-6'
          : 'border border-line-11 bg-surface-1 text-ink-7 hover:bg-surface-16'
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
    <div className="mt-4 flex items-center justify-between gap-4 border-t border-line-2 pt-3.5">
      <span className="flex items-center gap-2 font-sans text-[13px] leading-[20px] text-ink-10">
        {/* ★ A HEART MISLABELS A STAKE FIGURE (2026-08-17). This is governance
            vote WEIGHT (HP behind the proposal), not a "like" — a heart reads
            as the wrong verb. `arrowBigUp` is already this app's icon for
            voting (left-rail's "Vote Witness" row uses the same glyph), so
            swapping to it is consistent with the app's own vocabulary instead
            of inventing new SVG art. Colour still carries the supported/not
            distinction the heart used to via `fill`. */}
        <Icons.arrowBigUp
          className={cn('h-[15px] w-[15px]', !showIndeterminate && isSupported ? 'text-ink-brand-6' : 'text-ink-14')}
          aria-hidden="true"
        />
        {t('proposals.card.vote_value')}{' '}
        {/* ★ FULL PRECISION WAS UNREADABLE (2026-08-17) — "64,790,469.25 HP"
            on a card meant to be skimmed. `formatHpCompact` (already built
            for return-threshold-card.tsx) renders "64.8M HP"; the exact
            figure moves to `title` for a reader who actually needs it. */}
        <strong className="tabular-nums text-ink-4" title={formatHp(voteValueHp)}>
          {formatHpCompact(voteValueHp)}
        </strong>
      </span>
      {showIndeterminate ? (
        <span
          className="font-sans text-[13px] leading-[20px] italic text-ink-14"
          data-testid="proposal-support-unavailable"
        >
          {/* Pending says it is still looking; unavailable says it failed. */}
          {votesPending ? t('proposals.card.votes_pending') : t('proposals.card.votes_unavailable')}
        </span>
      ) : isLiteBlocked ? (
        /* ★ THE GATE STAYS SHUT, THE REASON STOPS LYING (2026-08-13, adversarial
           review S4). `isLiteBlocked` is true for TWO different reasons — this is
           genuinely a lite account, or `/api/users/me` has not answered — and the
           second of those can now be permanent (a failed session read never sets
           `dataUpdatedAt`, so `clientAnswered` never flips). Telling a reader with
           a full Hive account "voting needs a full Hive account. Upgrade to vote"
           because our own request failed is a false statement about THEM. The
           button stays disabled either way; only the sentence changes. */
        <TooltipContainer
          title={identity.sessionUnavailable ? t('proposals.session_unavailable') : t('proposals.lite_cannot_vote')}
        >
          {button}
        </TooltipContainer>
      ) : isLoggedIn ? (
        button
      ) : (
        <DialogLogin>{button}</DialogLogin>
      )}
    </div>
  );
}
