'use client';

import { Link } from '@hive/ui';
import TimeAgo from '@ui/components/time-ago';
import { useTranslation } from '@/blog/i18n/client';
import type { DescribedHistoryEntry } from '../lib/account-history';

const TONE_CLASS: Record<DescribedHistoryEntry['tone'], string> = {
  credit: 'text-[#2f7d4f]',
  debit: 'text-[#c0392b]',
  neutral: 'text-[#3f4650]'
};

const TONE_SIGN: Record<DescribedHistoryEntry['tone'], string> = {
  credit: '+',
  debit: '-',
  neutral: ''
};

/**
 * One row of the wallet's "Recent activity" card. Deliberately NOT a table
 * row: at 390px a table forces either a fixed-width column layout (the
 * horizontal-scroll trap /witnesses hit — see features/witnesses/lib/table-
 * grid.tsx) or squeezed, truncated text. A flex-wrap row with `min-w-0` on
 * the text side and `shrink-0` on the amount lets a long description or
 * account name wrap onto its own line instead of forcing the row (or the
 * page) wider than the viewport.
 */
export default function AccountHistoryRow({ entry }: { entry: DescribedHistoryEntry }) {
  const { t } = useTranslation('common_blog');

  return (
    <div
      className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 border-t border-[#f1f3f5] py-3 first:border-t-0"
      data-testid="wallet-history-row"
    >
      <div className="min-w-0 flex-1">
        <p className="break-words text-[13.5px] text-[#2a2822]">
          {t(entry.labelKey, entry.labelParams)}
          {entry.counterparty ? (
            <>
              {' '}
              {t(`wallet.history.direction.${entry.counterparty.direction}`)}{' '}
              <Link
                href={`/@${entry.counterparty.name}`}
                className="font-semibold text-[#2a2822] hover:underline"
                data-testid="wallet-history-counterparty"
              >
                @{entry.counterparty.name}
              </Link>
            </>
          ) : null}
        </p>
        <span className="font-sans text-[12px] tabular-nums text-[#9ca3af]">
          <TimeAgo date={entry.timestamp as string | number | Date} />
        </span>
        {entry.memo ? (
          <p className="mt-0.5 break-all text-[12px] text-[#9ca3af]" data-testid="wallet-history-memo">
            {entry.memo}
          </p>
        ) : null}
      </div>

      {entry.amountText ? (
        <span
          className={`shrink-0 text-right font-sans text-[13.5px] font-semibold tabular-nums ${TONE_CLASS[entry.tone]}`}
          data-testid="wallet-history-amount"
        >
          {TONE_SIGN[entry.tone]}
          {entry.amountText}
        </span>
      ) : null}
    </div>
  );
}
