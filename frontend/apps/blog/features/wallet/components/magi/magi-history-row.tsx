'use client';

import { Link } from '@hive/ui';
import { useTranslation } from '@/blog/i18n/client';
import ActivityRow from '../activity-row';
import type { MagiHistoryEntry } from '../../lib/magi-history';

/**
 * One row of the Magi tab's activity list. The layout, colours and date rules
 * are `activity-row.tsx`, shared with the Hive tab, so the two feeds read as
 * one wallet; this file is the Magi-specific translation.
 *
 * ★ THE STATUS CHIP IS THE HALF THE HIVE TAB DOES NOT NEED. A Hive operation is
 * in a block or it does not exist. A Magi transaction can sit UNCONFIRMED or
 * INCLUDED for a while, and it can FAIL — and a failed transfer that rendered
 * as a plain "-5.000 HBD" would tell somebody their money left when it never
 * did. Failed and pending rows carry the chip, and a failed row carries no
 * sign (see describeMagiOperation).
 */
export default function MagiHistoryRow({ entry, explorerUrl }: { entry: MagiHistoryEntry; explorerUrl: string | null }) {
  const { t, i18n } = useTranslation('common_blog');
  const lang = i18n.resolvedLanguage ?? 'en';
  const status =
    entry.status === 'confirmed'
      ? null
      : entry.status === 'failed'
        ? { label: t('wallet.magi.history.status.failed'), tone: 'failed' as const }
        : { label: t('wallet.magi.history.status.pending'), tone: 'pending' as const };

  return (
    <ActivityRow
      category={entry.category}
      tone={entry.tone}
      timestamp={entry.timestamp}
      amountText={entry.amountText}
      noAmountText={t('wallet.history.no_amount')}
      memo={entry.memo}
      status={status}
      href={explorerUrl}
      hrefLabel={t('wallet.magi.history.view_on_explorer')}
      lang={lang}
      testId="wallet-magi-history-row"
      label={
        <>
          {t(entry.labelKey, entry.labelParams)}
          {entry.counterparty ? (
            <>
              {' '}
              {t(`wallet.history.direction.${entry.counterparty.direction}`)}{' '}
              {entry.counterparty.href ? (
                <Link
                  href={entry.counterparty.href}
                  className="font-medium text-ink-4 hover:underline"
                  data-testid="wallet-magi-history-counterparty"
                >
                  {entry.counterparty.label}
                </Link>
              ) : (
                <span className="font-mono font-medium text-ink-4" data-testid="wallet-magi-history-counterparty">
                  {entry.counterparty.label}
                </span>
              )}
            </>
          ) : null}
        </>
      }
    />
  );
}
