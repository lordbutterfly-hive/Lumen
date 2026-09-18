'use client';

import type { ReactNode } from 'react';
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, CircleDot, ExternalLink, PiggyBank, Sparkles, Zap } from 'lucide-react';
import TimeAgo from '@ui/components/time-ago';
import type { HistoryCategory } from '../lib/history-groups';
import type { HistoryTone } from '../lib/account-history';

/**
 * One row of a wallet activity list — Hive or Magi. The two feeds carry
 * different data (a Hive operation has no status; a Magi transaction has no
 * localized op vocabulary) but they are the same OBJECT to a reader: "something
 * moved, here is what and when", so they share one row rather than drifting
 * into two ledger styles inside one wallet.
 *
 * ★ W-8, kept: TWO SEMANTIC AMOUNT COLOURS, NOT THREE. A credit is green, a
 * debit is the brand red, and everything else is plain body colour — a number,
 * not a judgement. Each of the two is spelled out by the sign in front of it,
 * which is the legend.
 *
 * ★ THE CATEGORY IS THE THIRD DIMENSION, AND IT IS NOT A COLOUR ON ITS OWN
 * (2026-09-18). Tabs alone cannot say what a row IS: the "All" tab mixes a
 * reward, a power-up and a savings deposit, and all three are amount-neutral, so
 * before this they were three identical grey lines. Each category now carries an
 * icon in a tinted tile — the icon is the discriminator, the tint only
 * reinforces it, so the row still reads for anyone who cannot separate the
 * hues. Every colour below is an existing Lumen token with a dark-mode value;
 * none is a new hue invented for this list.
 */
const CATEGORY_STYLE: Record<HistoryCategory, { className: string; Icon: typeof ArrowDownLeft }> = {
  in: { className: 'bg-surface-ok-5 text-ink-ok-2', Icon: ArrowDownLeft },
  out: { className: 'bg-surface-brand-5 text-ink-brand-6', Icon: ArrowUpRight },
  reward: { className: 'bg-surface-warn-4 text-ink-warn-3', Icon: Sparkles },
  power: { className: 'bg-surface-info-1 text-ink-info-5', Icon: Zap },
  savings: { className: 'bg-surface-23 text-ink-violet-1', Icon: PiggyBank },
  market: { className: 'bg-surface-23 text-ink-8', Icon: ArrowLeftRight },
  other: { className: 'bg-surface-23 text-ink-8', Icon: CircleDot }
};

const TONE_CLASS: Record<HistoryTone, string> = {
  credit: 'text-ink-ok-2',
  debit: 'text-ink-brand-6',
  neutral: 'text-ink-2'
};

const TONE_SIGN: Record<HistoryTone, string> = {
  credit: '+',
  debit: '-',
  neutral: ''
};

/** A transaction that has not settled yet, or settled badly. Hive rows never have one. */
export type ActivityStatus = { label: string; tone: 'pending' | 'failed' };

const STATUS_CLASS: Record<ActivityStatus['tone'], string> = {
  pending: 'bg-surface-warn-4 text-ink-warn-3',
  failed: 'bg-surface-brand-5 text-ink-brand-6'
};

/**
 * Hive sends `2026-08-08T21:07:30` with no zone marker, and per the ECMAScript
 * spec a string in that shape is parsed as LOCAL time. Appending `Z` is what
 * @ui/components/time-ago already does for the same reason; without it every
 * date here would be off by the reader's UTC offset, which on a ledger can move
 * a transaction to the wrong calendar day.
 */
export function parseChainDate(value: string | number | Date): Date {
  if (typeof value !== 'string') return new Date(value);
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
  return new Date(hasZone ? value : `${value}Z`);
}

/**
 * Deliberately NOT a table row: at 390px a table forces either a fixed-width
 * column layout (the horizontal-scroll trap /witnesses hit — see
 * features/witnesses/lib/table-grid.tsx) or squeezed, truncated text. A
 * flex-wrap row with `min-w-0` on the text side and `shrink-0` on the amount
 * lets a long description or account name wrap onto its own line instead of
 * forcing the row (or the page) wider than the viewport.
 *
 * ★ THE DATE IS ABSOLUTE (W-8). Every row read "yesterday" / "2 weeks ago" and
 * the only real date was a native `title`, i.e. invisible on a phone and to
 * anyone who does not think to hover. That is fine for a feed; it is not fine
 * for the record of where somebody's money went.
 */
export default function ActivityRow({
  category,
  tone,
  label,
  timestamp,
  amountText,
  noAmountText,
  memo,
  status,
  href,
  hrefLabel,
  lang,
  testId = 'wallet-history-row'
}: {
  category: HistoryCategory;
  tone: HistoryTone;
  /** Already localized, may carry an inline link to the counterparty. */
  label: ReactNode;
  timestamp: string | number | Date;
  amountText: string | null;
  /** What to print when the operation moved nothing, e.g. "No funds moved". */
  noAmountText: string;
  memo?: string | null;
  status?: ActivityStatus | null;
  /** External record of this transaction (Magi rows link to the explorer). */
  href?: string | null;
  /** Accessible name for that link; required whenever `href` is given. */
  hrefLabel?: string;
  lang: string;
  testId?: string;
}) {
  const { className: categoryClass, Icon } = CATEGORY_STYLE[category] ?? CATEGORY_STYLE.other;
  const date = parseChainDate(timestamp);
  const absoluteDate = date.toLocaleDateString(lang, { year: 'numeric', month: 'short', day: 'numeric' });

  return (
    <div
      className="flex flex-wrap items-start gap-x-3 gap-y-1 rounded-card border border-line-2 bg-surface-1 px-3.5 py-2.5 transition-colors hover:bg-surface-5 sm:px-[18px]"
      data-testid={testId}
      data-category={category}
    >
      <span
        className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-card ${categoryClass}`}
        aria-hidden
        data-testid={`${testId}-icon`}
      >
        <Icon size={16} strokeWidth={2} />
      </span>

      {/* ★ A FLOOR, NOT `min-w-0` (measured at 390px, 2026-09-18). With
          `min-w-0 flex-1` the text column shrinks below its own content to
          keep a long amount on the same line, and a reward row reading
          "+0.221 HIVE and 0.223 HP" squeezed "Claimed rewards" into one
          CHARACTER PER LINE. A basis floor makes the amount wrap onto its own
          line instead — the rule hive-token-card.tsx already follows, where
          the figure group wraps under the text at 390 rather than squeezing
          it into a column. */}
      <div className="min-w-[9rem] flex-1">
        <p className="break-words text-[14px] leading-[22px] text-ink-4">{label}</p>
        <span
          className="flex flex-wrap items-center gap-1.5 font-num font-medium text-caption text-ink-14"
          data-testid={`${testId}-timestamp`}
        >
          <time dateTime={date.toISOString()} title={date.toLocaleString(lang)}>
            {absoluteDate}
          </time>
          <span aria-hidden className="text-ink-24">
            ·
          </span>
          <TimeAgo date={timestamp} />
          {status ? (
            <span
              className={`rounded-control px-2 py-[1px] font-ui text-caption font-medium ${STATUS_CLASS[status.tone]}`}
              data-testid={`${testId}-status`}
            >
              {status.label}
            </span>
          ) : null}
          {href ? (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center text-ink-14 transition-colors hover:text-ink-brand-6"
              data-testid={`${testId}-link`}
            >
              <ExternalLink size={12} aria-hidden />
              <span className="sr-only">{hrefLabel ?? absoluteDate}</span>
            </a>
          ) : null}
        </span>
        {memo ? (
          // ★ CLAMPED TO TWO LINES (2026-09-18). A memo is arbitrary text a
          // STRANGER wrote: measured on a real wallet, one advertising memo ran
          // ten lines and pushed every other transaction off the screen. The
          // full text stays in the title attribute, and `break-all` still stops
          // an unbroken URL from widening the row.
          <p
            className="mt-0.5 line-clamp-2 break-all text-caption text-ink-14"
            title={memo}
            data-testid={`${testId}-memo`}
          >
            {memo}
          </p>
        ) : null}
      </div>

      {amountText ? (
        <span
          className={`ml-auto shrink-0 text-right font-num font-medium text-[14px] leading-[22px] ${TONE_CLASS[tone]}`}
          data-testid={`${testId}-amount`}
        >
          {TONE_SIGN[tone]}
          {amountText}
        </span>
      ) : (
        // ★ W-8: "Stopped power down" (and cancelling a savings withdrawal, and
        // any operation type this list does not format) left the amount side of
        // the row simply blank, which on a money list reads as a number that
        // failed to load. These operations genuinely move nothing, so the row
        // says so instead of leaving the reader to guess which it was.
        <span
          className="ml-auto shrink-0 text-right font-ui text-caption font-medium text-ink-14"
          data-testid={`${testId}-no-amount`}
        >
          {noAmountText}
        </span>
      )}
    </div>
  );
}
