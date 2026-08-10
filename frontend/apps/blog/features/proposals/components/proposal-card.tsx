'use client';

import { Link } from '@hive/ui';
import { getUserAvatarUrl } from '@ui/lib/avatar-utils';
import { cn } from '@ui/lib/utils';
import { useTranslation } from '@/blog/i18n/client';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { formatDateRange, parseChainDate } from '../lib/proposals-format';
import { ProposalViewModel } from '../lib/proposals-types';
import { useProposalVoteMutation } from '../hooks/use-proposal-vote-mutation';
import ProposalStatsColumn from './proposal-stats-column';
import ProposalSupportFooter from './proposal-support-footer';

const STATUS_STYLES: Record<string, string> = {
  active: 'bg-[#e9f5ee] text-[#2f7d4f]',
  inactive: 'bg-[#eef2ff] text-[#4c51bf]',
  expired: 'bg-[#f4f5f7] text-[#6b7280]'
};

interface Props {
  vm: ProposalViewModel;
  isSupported: boolean;
  /** The viewer's own votes couldn't be loaded — render Support as indeterminate, not "not supported". */
  votesUnavailable: boolean;
}

/**
 * One DHF proposal card — byline, title + #id, status pill + date range + permlink
 * (linked to the underlying post), the funded-aware stats column, and the real
 * Support / Un-support footer. Matches Proposals.dc.html's card layout 1:1.
 */
export default function ProposalCard({ vm, isSupported, votesUnavailable }: Props) {
  const { t } = useTranslation('common_blog');
  const { user } = useUserClient();
  const voteMutation = useProposalVoteMutation();
  const { proposal, id, voteValueHp } = vm;
  const postHref = `/proposals/@${proposal.creator}/${proposal.permlink}`;
  const statusClass = STATUS_STYLES[proposal.status] ?? STATUS_STYLES.inactive;

  const handleToggle = () => {
    voteMutation.mutate({ voter: user.username, proposalId: id, approve: !isSupported });
  };

  return (
    <article
      className="rounded-2xl border border-[#ebebeb] bg-white p-[20px_22px] transition-colors hover:border-[#e0ddd6]"
      data-testid="proposal-card"
    >
      <div className="grid grid-cols-[1fr_190px] gap-[22px]">
        <div className="min-w-0">
          {/* Byline */}
          <div className="mb-2 flex items-center gap-2.5 font-sans text-[13px] text-[#6b7280]">
            <Link href={`/@${proposal.creator}`} className="shrink-0" data-testid="proposal-card-avatar">
              <img
                src={getUserAvatarUrl(proposal.creator, 'small')}
                alt={proposal.creator}
                className="h-[30px] w-[30px] rounded-full object-cover"
              />
            </Link>
            <span>
              {t('proposals.card.by')}{' '}
              <Link href={`/@${proposal.creator}`} className="font-semibold text-[#2a2822] hover:underline">
                {proposal.creator}
              </Link>
            </span>
            <span aria-hidden="true" className="text-[#cbd0d6]">
              ·
            </span>
            <span>{parseChainDate(proposal.start_date).format('MMM D, YYYY')}</span>
          </div>

          {/* Title */}
          <Link href={postHref} data-testid="proposal-card-title">
            <h2 className="font-sans text-[21px] font-semibold leading-[1.25] tracking-[-0.01em] text-[#161511]">
              {proposal.subject} <span className="font-normal text-[#9ca3af]">#{id}</span>
            </h2>
          </Link>

          {/* Status pill + range + permlink */}
          <div className="mt-[11px] flex flex-wrap items-center gap-2.5 font-sans text-[12.5px] text-[#9ca3af]">
            <span
              className={cn(
                'rounded-[7px] px-2.5 py-[3px] text-[11px] font-bold uppercase tracking-[0.03em]',
                statusClass
              )}
            >
              {t(`proposals.status.${proposal.status}`, proposal.status)}
            </span>
            <span>{formatDateRange(proposal.start_date, proposal.end_date)}</span>
            <Link href={postHref} className="text-[#c0392b] hover:underline" data-testid="proposal-card-permlink">
              @{proposal.creator}/{proposal.permlink}
            </Link>
          </div>
        </div>

        <ProposalStatsColumn vm={vm} />
      </div>

      <ProposalSupportFooter
        isExpired={proposal.status === 'expired'}
        isLoggedIn={user.isLoggedIn}
        isSupported={isSupported}
        votesUnavailable={votesUnavailable}
        isPending={voteMutation.isLoading}
        voteValueHp={voteValueHp}
        onToggle={handleToggle}
      />
    </article>
  );
}
