'use client';

import { useMemo, useState } from 'react';
import { useTranslation } from '@/blog/i18n/client';
import { EmptyStateIllustration } from '@/blog/components/empty-state-illustration';
import { getCreatorTokensConfig } from '@/blog/features/creator-tokens/lib/creator-tokens-data-source';
import { getMagiBtcMappingContractId } from '@/blog/lib/lite/wallet/magi-btc-balance';
import { toMagiAccountId } from '@/blog/lib/lite/wallet/magi-assets';
import { getMagiSwapConfig } from '../../lib/magi-swap-config';
import { useMagiHistory } from '../../hooks/use-magi-history';
import {
  MAGI_HISTORY_GROUPS,
  describeMagiTransaction,
  magiExplorerTxUrl,
  type MagiHistoryEntry,
  type MagiHistoryGroup
} from '../../lib/magi-history';
import MagiHistoryRow from './magi-history-row';

const CARD_CLASS = 'mb-3 rounded-panel border border-line-9 bg-surface-1 p-5 sm:p-6';

/**
 * The Magi tab's activity list — the thing this tab was missing entirely
 * (owner, 2026-09-18: "the magi tab lacks any transactions from magi. take that
 * from altera, same system as the one for hive wallet you will build").
 *
 * Same card, same rows, same "load older" grammar as the Hive tab's
 * `history-card.tsx`; what differs is what the chain can tell us:
 *  - four tabs, because Magi's operation vocabulary is different (a contract
 *    call is a first-class movement here, and there are no rewards);
 *  - a status chip, because a Magi transaction can be pending or FAILED;
 *  - an explorer link per row, because a Magi transaction has a public record
 *    and no Hive block explorer shows it;
 *  - offset paging rather than a cursor (see use-magi-history.ts), so rows are
 *    de-duplicated by key here.
 *
 * ★ ONE LIST PER MAGI ACCOUNT, never merged. The tab above already shows one
 * balance card per account (a Hive account and/or each bound wallet) because
 * they are different accounts with different keys; merging their histories into
 * one feed would invent a single wallet that does not exist.
 */
export default function MagiHistoryList({
  account,
  accountLabel
}: {
  /** Ledger account id or bare Hive name; normalised here. */
  account: string;
  /** Names whose history this is, shown only when the reader holds more than one Magi account. */
  accountLabel?: string;
}) {
  const { t } = useTranslation('common_blog');
  const [group, setGroup] = useState<MagiHistoryGroup>('all');
  const accountId = toMagiAccountId(account);
  const config = getCreatorTokensConfig();
  const netId = config?.netId ?? null;
  /**
   * ★ THE THREE CONTRACTS THIS APP ITSELF DEPLOYS AGAINST, named. A reader who
   * just bought a Meritum token should not have to recognise
   * `vsc1Bisgg…dZARt` to know what the row is; every other contract keeps its
   * shortened id, because inventing a name for a contract we know nothing about
   * would be worse than showing the id.
   */
  const contractNames = useMemo(() => {
    const names: Record<string, string> = {};
    if (config?.contractId) names[config.contractId] = t('wallet.magi.history.contracts.meritum');
    const swap = getMagiSwapConfig();
    if (swap?.dexRouterContractId) names[swap.dexRouterContractId] = t('wallet.magi.history.contracts.dex');
    const btc = getMagiBtcMappingContractId();
    if (btc) names[btc] = t('wallet.magi.history.contracts.btc');
    return names;
  }, [config?.contractId, t]);
  const { data, isLoading, isError, fetchNextPage, hasNextPage, isFetchingNextPage } = useMagiHistory(account, group);

  const entries = useMemo(() => {
    const byKey = new Map<string, MagiHistoryEntry>();
    for (const page of data?.pages ?? []) {
      for (const tx of page) {
        for (const entry of describeMagiTransaction(tx, accountId, group, contractNames)) {
          // Offset paging can hand the same transaction back on two pages when
          // a new one lands mid-read. First copy wins; they are identical.
          if (!byKey.has(entry.key)) byKey.set(entry.key, entry);
        }
      }
    }
    return [...byKey.values()];
  }, [data, accountId, group, contractNames]);

  return (
    <div className={CARD_CLASS} data-testid="wallet-magi-history">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div>
          <div className="text-[16px] leading-[24px] font-semibold text-ink-2">{t('wallet.magi.history.label')}</div>
          {accountLabel ? (
            <div className="font-ui text-caption text-ink-10" data-testid="wallet-magi-history-account">
              {accountLabel}
            </div>
          ) : null}
        </div>
        <div
          role="tablist"
          aria-label={t('wallet.magi.history.groups.label')}
          className="inline-flex flex-wrap items-center gap-1.5 rounded-xl border border-line-6 bg-[var(--amb-1)] p-[5px] dark:bg-surface-23"
          data-testid="wallet-magi-history-groups"
        >
          {MAGI_HISTORY_GROUPS.map((value) => {
            const active = value === group;
            return (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setGroup(value)}
                style={active ? { boxShadow: 'var(--tab-active-glow)' } : undefined}
                className={`rounded-lg px-3.5 py-1.5 font-ui text-caption font-medium transition-colors ${
                  active ? 'bg-[var(--lum-1)] text-ink-2 dark:bg-surface-1' : 'text-ink-10 hover:text-ink-4'
                }`}
                data-testid={`wallet-magi-history-group-${value}`}
              >
                {t(`wallet.magi.history.groups.${value}`)}
              </button>
            );
          })}
        </div>
      </div>

      {isError ? (
        // Never an empty list: "we could not ask" and "you have never
        // transacted" are different facts (magi-balance.ts:26-29).
        <p className="py-6 text-center text-[14px] leading-[22px] text-destructive" data-testid="wallet-magi-history-error">
          {t('wallet.magi.history.error')}
        </p>
      ) : isLoading ? (
        <p className="py-6 text-center text-[14px] leading-[22px] text-ink-14" data-testid="wallet-magi-history-loading">
          {t('wallet.magi.history.loading')}
        </p>
      ) : entries.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-8 text-center" data-testid="wallet-magi-history-empty">
          <EmptyStateIllustration name="empty-wallet" size={104} />
          <p className="text-[14px] leading-[22px] text-ink-14">{t(`wallet.magi.history.empty_${group}`)}</p>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-2" data-testid="wallet-magi-history-rows">
            {entries.map((entry) => (
              <MagiHistoryRow key={entry.key} entry={entry} explorerUrl={magiExplorerTxUrl(entry.txId, netId)} />
            ))}
          </div>
          <div className="mt-3 flex flex-col items-center gap-2 border-t border-line-2 pt-3">
            {hasNextPage ? (
              <button
                type="button"
                onClick={() => fetchNextPage()}
                disabled={isFetchingNextPage}
                className="lm-press rounded-card border border-line-11 px-4 py-2 text-caption font-medium text-ink-7 transition-colors hover:bg-surface-16 disabled:opacity-60"
                data-testid="wallet-magi-history-load-more"
              >
                {isFetchingNextPage ? t('wallet.history.loading_older') : t('wallet.history.load_older')}
              </button>
            ) : (
              <p className="text-caption text-ink-14" data-testid="wallet-magi-history-end">
                {t('wallet.history.end_of_history')}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
