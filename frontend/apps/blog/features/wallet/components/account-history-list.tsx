'use client';

import { GetDynamicGlobalPropertiesResponse } from '@hiveio/wax';
import { Chain } from '@transaction/lib/chain';
import { useTranslation } from '@/blog/i18n/client';
import { useAccountHistory } from '../hooks/use-account-history';
import { describeHistoryOperation, DescribedHistoryEntry } from '../lib/account-history';
import { getTransfersUrl } from '../lib/wallet-endpoint';
import AccountHistoryRow from './account-history-row';

const CARD_CLASS = 'rounded-[18px] border border-[#ebebeb] bg-white p-5 sm:p-6';

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
export default function AccountHistoryList({
  username,
  chain,
  dynamicGlobal
}: {
  username: string;
  chain: Chain | null;
  dynamicGlobal: GetDynamicGlobalPropertiesResponse | null;
}) {
  const { t, i18n } = useTranslation('common_blog');
  const { data, isLoading, isError } = useAccountHistory(username);
  const transfersUrl = getTransfersUrl(username);
  const lang = i18n.resolvedLanguage ?? 'en';

  const entries: DescribedHistoryEntry[] = (data?.operations ?? [])
    .map((op) => describeHistoryOperation(op, { username, chain, dynamicGlobal }, lang))
    .filter((entry): entry is DescribedHistoryEntry => entry !== null);

  const hasMore = (data?.totalOperations ?? 0) > entries.length;

  return (
    <section id="wallet-history" className="mt-[34px]">
      <div className="mb-4 flex items-center gap-3.5">
        <span className="text-[11.5px] font-bold uppercase tracking-[0.09em] text-[#9ca3af]">
          {t('wallet.history.label')}
        </span>
        <div className="h-px flex-1 bg-[#ebebeb]" />
      </div>

      <div className={CARD_CLASS} data-testid="wallet-history-card">
        {isError ? (
          <p className="py-6 text-center text-[13.5px] text-destructive" data-testid="wallet-history-error">
            {t('wallet.history.error')}
          </p>
        ) : isLoading ? (
          <p className="py-6 text-center text-[13.5px] text-[#9ca3af]" data-testid="wallet-history-loading">
            {t('wallet.history.loading')}
          </p>
        ) : entries.length === 0 ? (
          <p className="py-6 text-center text-[13.5px] text-[#9ca3af]" data-testid="wallet-history-empty">
            {t('wallet.history.empty')}
          </p>
        ) : (
          <>
            <div className="flex flex-col" data-testid="wallet-history-rows">
              {entries.map((entry) => (
                <AccountHistoryRow key={entry.key} entry={entry} />
              ))}
            </div>
            {hasMore && transfersUrl !== '#' ? (
              <div className="mt-3 border-t border-[#f1f3f5] pt-3 text-center">
                <a
                  href={transfersUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[12.5px] font-semibold text-[#c0392b] hover:text-[#96271b]"
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
