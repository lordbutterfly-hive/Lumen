'use client';

import { Icons } from '@ui/components/icons';
import { useTranslation } from '@/blog/i18n/client';
import NewProposalDialog from './new-proposal-dialog';

/** "Decentralized Hive Fund" heading + intro + the real New proposal dialog trigger. */
export default function ProposalsMainHeader() {
  const { t } = useTranslation('common_blog');

  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h1 className="font-sans text-[32px] font-bold tracking-[-0.02em] text-[#161511]">
          {t('proposals.header.title')}
        </h1>
        <p className="mt-2 max-w-[620px] font-serif text-sm leading-[1.55] text-[#6b7280]">
          {t('proposals.header.intro')}{' '}
          <a href="/faq.html" className="text-[#c0392b] hover:underline">
            {t('proposals.header.faq_link')}
          </a>
          .
        </p>
      </div>
      <NewProposalDialog>
        <button
          type="button"
          className="flex shrink-0 items-center gap-1.5 rounded-[11px] bg-[#1a1a17] px-[18px] py-[11px] font-sans text-sm font-semibold text-white transition-colors hover:bg-black"
          data-testid="new-proposal-open"
        >
          <Icons.add className="h-[15px] w-[15px]" />
          {t('proposals.header.new_proposal')}
        </button>
      </NewProposalDialog>
    </div>
  );
}
