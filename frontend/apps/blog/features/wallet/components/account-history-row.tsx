'use client';

import { Link } from '@hive/ui';
import { useTranslation } from '@/blog/i18n/client';
import type { DescribedHistoryEntry } from '../lib/account-history';
import ActivityRow from './activity-row';

/**
 * One row of the Hive tab's activity list. All the layout, colour and date
 * rules live in `activity-row.tsx`, which the Magi tab's rows share; this file
 * is only the Hive-specific translation: an i18n key plus params, and the
 * counterparty rendered as a link to their Lumen profile.
 */
export default function AccountHistoryRow({ entry }: { entry: DescribedHistoryEntry }) {
  const { t, i18n } = useTranslation('common_blog');
  const lang = i18n.resolvedLanguage ?? 'en';

  return (
    <ActivityRow
      category={entry.category}
      tone={entry.tone}
      timestamp={entry.timestamp as string | number | Date}
      amountText={entry.amountText}
      noAmountText={t('wallet.history.no_amount')}
      memo={entry.memo}
      lang={lang}
      label={
        <>
          {t(entry.labelKey, entry.labelParams)}
          {entry.counterparty ? (
            <>
              {' '}
              {t(`wallet.history.direction.${entry.counterparty.direction}`)}{' '}
              <Link
                href={`/@${entry.counterparty.name}`}
                className="font-medium text-ink-4 hover:underline"
                data-testid="wallet-history-counterparty"
              >
                @{entry.counterparty.name}
              </Link>
            </>
          ) : null}
        </>
      }
    />
  );
}
