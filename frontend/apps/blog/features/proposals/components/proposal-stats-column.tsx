'use client';

import dayjs from 'dayjs';
import { useTranslation } from '@/blog/i18n/client';
import { assetToNumber, formatHbd, parseChainDate } from '../lib/proposals-format';
import { ProposalViewModel } from '../lib/proposals-types';

/**
 * Right-hand numbers column. Deliberately does NOT show "Paid so far" / "To pay"
 * for a proposal that isn't actually funded today — status 'active' alone does not
 * mean it's being paid (see computeFundingState). Showing those figures for an
 * unfunded proposal would fabricate money the account never received.
 */
export default function ProposalStatsColumn({ vm }: { vm: ProposalViewModel }) {
  const { t } = useTranslation('common_blog');
  const { proposal, isFunded, daysRemaining, paidHbd, toPayHbd } = vm;
  const dailyPayHbd = assetToNumber(proposal.daily_pay);

  if (proposal.status === 'expired') {
    return (
      <div className="flex flex-col items-end gap-1 font-sans text-caption text-ink-10" data-testid="proposal-stats-expired">
        <div className="tabular-nums">{t('proposals.card.ended', { date: parseChainDate(proposal.end_date).format('MMM D, YYYY') })}</div>
      </div>
    );
  }

  if (proposal.status === 'inactive' && parseChainDate(proposal.start_date).isAfter(dayjs())) {
    return (
      <div className="flex flex-col items-end gap-1 font-sans text-caption text-ink-10" data-testid="proposal-stats-upcoming">
        <div className="tabular-nums">{t('proposals.card.starts', { date: parseChainDate(proposal.start_date).format('MMM D, YYYY') })}</div>
      </div>
    );
  }

  if (!isFunded) {
    return (
      <div className="flex flex-col items-end gap-1 font-sans text-caption text-ink-10" data-testid="proposal-stats-unfunded">
        <div>
          {t('proposals.card.requested')} <strong className="tabular-nums text-ink-7">{formatHbd(dailyPayHbd)}</strong>
        </div>
        <div className="tabular-nums">{t('proposals.card.below_threshold')}</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1 font-sans text-caption text-ink-10" data-testid="proposal-stats-funded">
      <div>
        {t('proposals.card.daily_pay')}{' '}
        <strong className="tabular-nums text-ink-ok-2">{formatHbd(dailyPayHbd)}</strong>
      </div>
      <div className="tabular-nums">{t('proposals.card.remaining', { count: daysRemaining })}</div>
      <div className="tabular-nums">
        {t('proposals.card.paid')} {formatHbd(paidHbd)}
      </div>
      <div className="tabular-nums">
        {t('proposals.card.to_pay')} {formatHbd(toPayHbd)}
      </div>
    </div>
  );
}
