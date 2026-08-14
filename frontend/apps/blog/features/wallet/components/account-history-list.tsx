'use client';

import { useTranslation } from '@/blog/i18n/client';
import { useAccountHistory } from '../hooks/use-account-history';
import { getTransfersUrl } from '../lib/wallet-endpoint';
import AccountHistoryRow from './account-history-row';

const CARD_CLASS = 'rounded-[18px] border border-line-9 bg-surface-1 p-5 sm:p-6';

/**
 * "Recent activity" — the transaction/account-history list that used to sit
 * below the balances and stopped rendering when the wallet page was rebuilt
 * for Lumen (the new wallet-content.tsx never grew a replacement; there was
 * no failing query to fix, the section itself was never ported). Restored
 * here as its own card, matching the section-label + card pattern
 * SavingsVault already uses on this same page, rather than porting
 * apps/wallet's HistoryTable (a wide `<table>`, wax custom-formatter classes
 * and a filter bar) into a page that has no other tables.
 */
export default function AccountHistoryList({ username }: { username: string }) {
  const { t, i18n } = useTranslation('common_blog');
  const lang = i18n.resolvedLanguage ?? 'en';
  // ★ The rows arrive already described (2026-08-13) — see use-account-history.ts
  // and app/api/wallet/history/route.ts for why the describing had to move to the
  // server along with the two REST calls it depends on.
  const { data, isLoading, isError } = useAccountHistory(username, lang);
  const transfersUrl = getTransfersUrl(username);

  const entries = data?.entries ?? [];
  const hasMore = (data?.totalOperations ?? 0) > entries.length;

  return (
    <section id="wallet-history" className="mt-[34px]">
      <div className="mb-4 flex items-center gap-3.5">
        <span className="text-[12px] font-bold uppercase tracking-[0.09em] text-ink-14">
          {t('wallet.history.label')}
        </span>
        <div className="h-px flex-1 bg-surface-27" />
      </div>

      <div className={CARD_CLASS} data-testid="wallet-history-card">
        {isError ? (
          <p className="py-6 text-center text-[14px] leading-[22px] text-destructive" data-testid="wallet-history-error">
            {t('wallet.history.error')}
          </p>
        ) : isLoading ? (
          <p className="py-6 text-center text-[14px] leading-[22px] text-ink-14" data-testid="wallet-history-loading">
            {t('wallet.history.loading')}
          </p>
        ) : entries.length === 0 ? (
          <p className="py-6 text-center text-[14px] leading-[22px] text-ink-14" data-testid="wallet-history-empty">
            {t('wallet.history.empty')}
          </p>
        ) : (
          <>
            {/* Rows are discrete 14px blocks now (see account-history-row.tsx),
                so they need a gap rather than the hairline they used to share. */}
            <div className="flex flex-col gap-2" data-testid="wallet-history-rows">
              {entries.map((entry) => (
                <AccountHistoryRow key={entry.key} entry={entry} />
              ))}
            </div>
            {hasMore && transfersUrl !== '#' ? (
              <div className="mt-3 border-t border-line-2 pt-3 text-center">
                <a
                  href={transfersUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[13px] leading-[20px] font-semibold text-ink-brand-6 hover:text-ink-brand-4"
                  data-testid="wallet-history-view-more"
                >
                  {t('wallet.history.view_full')}
                </a>
              </div>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
