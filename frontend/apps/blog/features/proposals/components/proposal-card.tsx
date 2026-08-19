'use client';

import { Link, UserAvatarImg } from '@hive/ui';
import { cn } from '@ui/lib/utils';
import { useTranslation } from '@/blog/i18n/client';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import { formatDateRange, parseChainDate } from '../lib/proposals-format';
import { ProposalViewModel } from '../lib/proposals-types';
import { useProposalVoteMutation } from '../hooks/use-proposal-vote-mutation';
import ProposalStatsColumn from './proposal-stats-column';
import ProposalSupportFooter from './proposal-support-footer';

const STATUS_STYLES: Record<string, string> = {
  active: 'bg-surface-ok-5 text-ink-ok-2',
  inactive: 'bg-surface-info-2 text-ink-info-3',
  expired: 'bg-surface-21 text-ink-10'
};

interface Props {
  vm: ProposalViewModel;
  isSupported: boolean;
  /** The viewer's own votes couldn't be loaded — render Support as indeterminate, not "not supported". */
  votesUnavailable: boolean;
  votesPending: boolean;
}

/**
 * One DHF proposal card — byline, title + #id, status pill + date range + permlink
 * (linked to the underlying post), the funded-aware stats column, and the real
 * Support / Un-support footer. Matches Proposals.dc.html's card layout 1:1.
 */
export default function ProposalCard({ vm, isSupported, votesUnavailable, votesPending }: Props) {
  const { t } = useTranslation('common_blog');
  /**
   * ★ SAME DEFECT AS /witnesses (2026-08-11, class sweep). `user.isLoggedIn` cannot
   * answer during SSR and reports "signed out" on the client until `/api/users/me`
   * returns, so a signed-in reader's Support button rendered wrapped in
   * `DialogLogin` (opens the login modal on click instead of casting the vote) for
   * up to several seconds after every page load. `identity` prefers the client's
   * answer once it has genuinely arrived and falls back to the session the SERVER
   * read from the cookie until then — see features/layouts/server-session.tsx.
   */
  const identity = useSessionIdentity();
  const voteMutation = useProposalVoteMutation();
  const { proposal, id, voteValueHp } = vm;
  const postHref = `/proposals/@${proposal.creator}/${proposal.permlink}`;
  const statusClass = STATUS_STYLES[proposal.status] ?? STATUS_STYLES.inactive;

  const handleToggle = () => {
    // ★ FOLLOW-THROUGH FIX (2026-08-11). The Support button below is enabled
    // from `identity.isLoggedIn` (via ProposalSupportFooter's `isLoggedIn`
    // prop), so the voter this click reports must come from that SAME object —
    // not from the raw `useUserClient()` user, which can still read `username:
    // ''` in the exact window where `identity.isLoggedIn` is already true (cold
    // tab, session cookie, no localStorage seed). `identity.username` is always
    // populated in lockstep with `identity.isLoggedIn` (see server-session.tsx:
    // every branch of useSessionIdentity returns isLoggedIn/username from one
    // atomic source). Using the raw user here previously let a click send
    // `voter: ''`, which optimistically updated the wrong react-query cache key
    // (`['proposalVotes', '']`) while the broadcast still went out for the real
    // signed-in account.
    voteMutation.mutate({ voter: identity.username, proposalId: id, approve: !isSupported });
  };

  return (
    <article
      className="rounded-2xl border border-line-9 bg-surface-1 p-[20px_22px] transition-colors hover:border-line-17"
      data-testid="proposal-card"
    >
      <div className="grid grid-cols-[1fr_190px] gap-[22px]">
        <div className="min-w-0">
          {/* Byline */}
          <div className="mb-2 flex items-center gap-2.5 font-sans text-caption text-ink-10">
            {/* ★ CONVERGED (F6 item 22). This had no fallback at all — a dead
                Steemit-era `profile_image` or a lite account with no Hive avatar
                showed the browser's broken-image glyph next to the proposal's
                creator. The app's one avatar component, direct host then proxy
                then monogram, same as everywhere else. */}
            <Link href={`/@${proposal.creator}`} className="shrink-0" data-testid="proposal-card-avatar">
              <UserAvatarImg username={proposal.creator} pixelSize={30} alt={proposal.creator} />
            </Link>
            <span>
              {t('proposals.card.by')}{' '}
              <Link href={`/@${proposal.creator}`} className="font-semibold text-ink-4 hover:underline">
                {proposal.creator}
              </Link>
            </span>
            <span aria-hidden="true" className="text-ink-21">
              ·
            </span>
            <span>{parseChainDate(proposal.start_date).format('MMM D, YYYY')}</span>
          </div>

          {/* Title */}
          <Link href={postHref} data-testid="proposal-card-title">
            <h2 className="font-sans text-[22px] font-semibold leading-[28px] tracking-[-0.01em] text-ink-2">
              {proposal.subject} <span className="font-normal text-ink-14">#{id}</span>
            </h2>
          </Link>

          {/* Status pill + range + permlink */}
          <div className="mt-[11px] flex flex-wrap items-center gap-2.5 font-sans text-caption text-ink-14">
            <span
              className={cn(
                'rounded-control px-2.5 py-[3px] text-label font-bold uppercase tracking-label',
                statusClass
              )}
            >
              {t(`proposals.status.${proposal.status}`, proposal.status)}
            </span>
            <span>{formatDateRange(proposal.start_date, proposal.end_date)}</span>
            {/* ★ RAW PERMLINK REMOVED (2026-08-17). This used to print
                `@creator/permlink` as its own prominent brand-red link — the
                chain's internal slug, not something a reader needs to see.
                The title above (`proposal-card-title`) already links to the
                same `postHref`, so the click-through lives there instead of
                being duplicated as a second, more cryptic-looking link. */}
          </div>
        </div>

        <ProposalStatsColumn vm={vm} />
      </div>

      <ProposalSupportFooter
        isExpired={proposal.status === 'expired'}
        isLoggedIn={identity.isLoggedIn}
        isSupported={isSupported}
        votesUnavailable={votesUnavailable}
        votesPending={votesPending}
        isPending={voteMutation.isLoading}
        voteValueHp={voteValueHp}
        onToggle={handleToggle}
      />
    </article>
  );
}
