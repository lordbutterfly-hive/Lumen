'use client';

import { Icons } from '@ui/components/icons';
import TooltipContainer from '@ui/components/tooltip-container';
import DialogLogin from '@/blog/components/dialog-login';
import { useTranslation } from '@/blog/i18n/client';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import { useWitnessVoteMutation } from './hooks/use-witness-vote-mutation';

interface WitnessVoteToggleProps {
  witness: string;
  isVoted: boolean;
  isLoggedIn: boolean;
  /** True when the viewer has an active witness proxy — Hive requires clearing it before voting directly. */
  hasProxy: boolean;
  /** True when the viewer's own votes couldn't be loaded — the voted/not-voted state is unknown. */
  votesUnavailable: boolean;
}

const BASE_CLASS =
  'flex h-8 w-[38px] items-center justify-center rounded-control transition-colors disabled:cursor-not-allowed disabled:opacity-60';
const VOTED_CLASS = 'bg-surface-ok-7 text-ink-27';
const UNVOTED_CLASS = 'bg-surface-25 text-ink-15 hover:bg-surface-30 hover:text-ink-10';
const INDETERMINATE_CLASS = 'border border-dashed border-line-22 bg-transparent text-ink-14';

/**
 * The Vote cell: a real toggle that broadcasts `account_witness_vote`
 * (approve/un-approve) through `useWitnessVoteMutation`. Turns green while
 * voted. Gates on login (opens the real sign-in dialog) and on an active
 * proxy (disabled with an explanatory tooltip — Hive consensus rejects a
 * witness vote while a proxy is set, so this isn't a dead click, it's an
 * honest reflection of a real chain precondition).
 */
export default function WitnessVoteToggle({
  witness,
  isVoted,
  isLoggedIn,
  hasProxy,
  votesUnavailable
}: WitnessVoteToggleProps) {
  const { t } = useTranslation('common_blog');
  const { user } = useUserClient();
  // ★ MIXED SOURCES ARE THE BUG (2026-08-23). `isLoggedIn` arrives as a prop derived from
  // `useSessionIdentity()`, which answers instantly off the server cookie; `account_tier`
  // comes from `useUserClient()`, which waits on `/api/users/me` — measured at ~10s cold on
  // this box. In that window the tier is `undefined`, so `=== 'lite'` was false and a lite
  // account saw a fully enabled Vote button. Treat the account as blocked until the client
  // genuinely answers: a briefly-disabled button beats a lite user clicking a vote they
  // cannot sign. Same shape as `proposal-support-footer.tsx`, which fixed this first.
  const identity = useSessionIdentity();
  const voteMutation = useWitnessVoteMutation();
  const isPending = voteMutation.isLoading && voteMutation.variables?.witness === witness;

  if (!isLoggedIn) {
    // ★ GREYED-OUT CONTROL, NO HOVER EXPLANATION (2026-08-17). Every other
    // disabled/indeterminate branch below (lite, votesUnavailable, hasProxy)
    // wraps its button in `TooltipContainer`. This one can't: `DialogLogin`
    // (apps/blog/components/dialog-login.tsx, outside this fix's owned
    // files) only destructures `children`/`redirectTo` and does not spread
    // extra props onto its `DialogTrigger asChild` output, so a Tooltip's
    // hover/focus handlers placed around it would never reach the real
    // button — the popup would silently never open. Same structural
    // conflict already diagnosed and documented at
    // features/votes/votes-component.tsx:738-751 for the identical
    // DialogLogin-wrapped case. A native `title` sidesteps it entirely
    // (it's a plain attribute on the real DOM button, not a wrapper
    // component), reusing the same reason string already computed for
    // `aria-label` rather than inventing new copy.
    return (
      <DialogLogin>
        <button
          type="button"
          data-testid={`witness-vote-${witness}`}
          aria-label={t('witnesses.vote.login_required_aria')}
          title={t('witnesses.vote.login_required_aria')}
          className={`${BASE_CLASS} ${UNVOTED_CLASS}`}
        >
          <Icons.check className="h-4 w-4" />
        </button>
      </DialogLogin>
    );
  }

  // A lite account has no Hive keys — the mutation backstop already refuses this
  // (use-witness-vote-mutation.ts -> refuseIfLite), but the button used to render
  // fully enabled until clicked. Gate it here too, same pattern as `hasProxy` below.
  // ★ AND THE TOOLTIP MUST NOT LIE. `clientAnswered` never flips true if `/api/users/me`
  // fails terminally, so a bare gate would tell a full Hive account "voting needs a full
  // Hive account" — a false statement about them — permanently. The gate stays shut either
  // way; only the sentence changes. `proposal-support-footer.tsx` does exactly this.
  const isLiteBlocked = isLoggedIn && (!identity.clientAnswered || user.account_tier === 'lite');
  // ★ THREE BRANCHES, NOT TWO (corrected 2026-08-23). `sessionUnavailable` is
  // `isError && dataUpdatedAt === 0 && fetchStatus === 'idle'` — it is FALSE while the
  // request is still in flight. So a two-branch version told a full Hive account "voting
  // needs a full Hive account" for the entire ~10s cold window, which is precisely the
  // window this gate exists to cover. Loading is neither "you are lite" nor "we failed";
  // it gets its own, true sentence.
  const blockedTitle = identity.sessionUnavailable
    ? t('witnesses.session_unavailable')
    : !identity.clientAnswered
      ? t('global.loading')
      : t('witnesses.lite_cannot_vote');
  if (isLiteBlocked) {
    return (
      <TooltipContainer title={blockedTitle}>
        <button
          type="button"
          data-testid={`witness-vote-${witness}`}
          aria-label={blockedTitle}
          disabled
          className={`${BASE_CLASS} ${UNVOTED_CLASS}`}
        >
          <Icons.check className="h-4 w-4" />
        </button>
      </TooltipContainer>
    );
  }

  // Own-votes fetch failed: we don't know whether the viewer voted for this witness,
  // so show an explicit "unknown" toggle instead of a confident (possibly wrong) "not voted".
  if (votesUnavailable) {
    return (
      <TooltipContainer title={t('witnesses.vote.votes_unavailable')}>
        <button
          type="button"
          data-testid={`witness-vote-${witness}`}
          aria-label={t('witnesses.vote.votes_unavailable')}
          disabled
          className={`${BASE_CLASS} ${INDETERMINATE_CLASS}`}
        >
          <span aria-hidden className="text-sm font-bold leading-none">
            —
          </span>
        </button>
      </TooltipContainer>
    );
  }

  const button = (
    <button
      type="button"
      data-testid={`witness-vote-${witness}`}
      aria-pressed={isVoted}
      aria-label={
        isVoted ? t('witnesses.vote.remove_aria', { witness }) : t('witnesses.vote.add_aria', { witness })
      }
      disabled={hasProxy || voteMutation.isLoading}
      className={`${BASE_CLASS} ${isVoted ? VOTED_CLASS : UNVOTED_CLASS}`}
      onClick={() => voteMutation.mutate({ witness, approve: !isVoted })}
    >
      {isPending ? <Icons.spinner className="h-4 w-4 animate-spin" /> : <Icons.check className="h-4 w-4" />}
    </button>
  );

  if (hasProxy) {
    return <TooltipContainer title={t('witnesses.vote.proxy_blocks_voting')}>{button}</TooltipContainer>;
  }

  return button;
}
