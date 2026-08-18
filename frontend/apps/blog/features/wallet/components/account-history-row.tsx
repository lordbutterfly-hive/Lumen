'use client';

import { Link } from '@hive/ui';
import TimeAgo from '@ui/components/time-ago';
import { useTranslation } from '@/blog/i18n/client';
import type { DescribedHistoryEntry } from '../lib/account-history';

/**
 * ★ W-8: TWO SEMANTIC COLOURS, NOT THREE.
 *
 * A credit was green, a debit was red, and everything else (a market trade, a
 * power up, a move into savings) was a THIRD colour, #3f4650, that meant only
 * "none of the above" — three amount colours on a financial list with nothing
 * anywhere saying what they meant. Green and red are kept because they are
 * genuinely deltas and each one is spelled out by the sign in front of it, which
 * is the legend. Everything else is now plain body colour: a number, not a
 * judgement.
 */
const TONE_CLASS: Record<DescribedHistoryEntry['tone'], string> = {
  credit: 'text-ink-ok-2',
  debit: 'text-ink-brand-6',
  neutral: 'text-ink-2'
};

const TONE_SIGN: Record<DescribedHistoryEntry['tone'], string> = {
  credit: '+',
  debit: '-',
  neutral: ''
};

/**
 * Hive sends `2026-08-08T21:07:30` with no zone marker, and per the ECMAScript
 * spec a string in that shape is parsed as LOCAL time. Appending `Z` is what
 * @ui/components/time-ago already does for the same reason; without it every
 * date here would be off by the reader's UTC offset, which on a ledger can move
 * a transaction to the wrong calendar day.
 */
function parseHiveDate(value: string | number | Date): Date {
  if (typeof value !== 'string') return new Date(value);
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
  return new Date(hasZone ? value : `${value}Z`);
}

/**
 * One row of the wallet's "Recent activity" card. Deliberately NOT a table
 * row: at 390px a table forces either a fixed-width column layout (the
 * horizontal-scroll trap /witnesses hit — see features/witnesses/lib/table-
 * grid.tsx) or squeezed, truncated text. A flex-wrap row with `min-w-0` on
 * the text side and `shrink-0` on the amount lets a long description or
 * account name wrap onto its own line instead of forcing the row (or the
 * page) wider than the viewport.
 *
 * ★ W-8, the other two halves:
 *
 *  * THE DATE IS ABSOLUTE. Every row read "yesterday" / "2 weeks ago" and the
 *    only real date was a native `title`, i.e. invisible on a phone and to
 *    anyone who does not think to hover. That is fine for a feed; it is not
 *    fine for the record of where somebody's money went. The calendar date now
 *    leads and the relative phrase follows it, so the row still answers "how
 *    long ago" at a glance without being the only thing it answers.
 *
 *  * THE ROW HAS A RADIUS. These were square (measured: borderRadius 0px) on a
 *    page whose every other row is 14px. Same 14px bordered block the Savings
 *    Vault slots already use one card up, so a ledger entry and a savings slot
 *    read as the same kind of object.
 */
export default function AccountHistoryRow({ entry }: { entry: DescribedHistoryEntry }) {
  const { t, i18n } = useTranslation('common_blog');
  const lang = i18n.resolvedLanguage ?? 'en';
  const date = parseHiveDate(entry.timestamp as string | number | Date);
  const absoluteDate = date.toLocaleDateString(lang, { year: 'numeric', month: 'short', day: 'numeric' });

  return (
    <div
      className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 rounded-card border border-line-2 bg-surface-1 px-[18px] py-3.5 transition-colors hover:bg-surface-5"
      data-testid="wallet-history-row"
    >
      <div className="min-w-0 flex-1">
        <p className="break-words text-[14px] leading-[22px] text-ink-4">
          {t(entry.labelKey, entry.labelParams)}
          {entry.counterparty ? (
            <>
              {' '}
              {t(`wallet.history.direction.${entry.counterparty.direction}`)}{' '}
              <Link
                href={`/@${entry.counterparty.name}`}
                className="font-semibold text-ink-4 hover:underline"
                data-testid="wallet-history-counterparty"
              >
                @{entry.counterparty.name}
              </Link>
            </>
          ) : null}
        </p>
        <span
          className="flex flex-wrap items-center gap-1.5 font-sans text-[12px] tabular-nums text-ink-14"
          data-testid="wallet-history-timestamp"
        >
          <time dateTime={date.toISOString()} title={date.toLocaleString(lang)}>
            {absoluteDate}
          </time>
          <span aria-hidden className="text-ink-24">
            ·
          </span>
          <TimeAgo date={entry.timestamp as string | number | Date} />
        </span>
        {entry.memo ? (
          <p className="mt-0.5 break-all text-[12px] text-ink-14" data-testid="wallet-history-memo">
            {entry.memo}
          </p>
        ) : null}
      </div>

      {entry.amountText ? (
        <span
          className={`shrink-0 text-right font-sans text-[14px] leading-[22px] font-semibold tabular-nums ${TONE_CLASS[entry.tone]}`}
          data-testid="wallet-history-amount"
        >
          {TONE_SIGN[entry.tone]}
          {entry.amountText}
        </span>
      ) : (
        // ★ W-8: "Stopped power down" (and cancelling a savings withdrawal, and
        // any operation type this list does not format) left the amount side of
        // the row simply blank, which on a money list reads as a number that
        // failed to load. These operations genuinely move nothing, so the row
        // says so instead of leaving the reader to guess which it was.
        <span
          className="shrink-0 text-right font-sans text-[13px] leading-[20px] font-medium text-ink-14"
          data-testid="wallet-history-no-amount"
        >
          {t('wallet.history.no_amount')}
        </span>
      )}
    </div>
  );
}
