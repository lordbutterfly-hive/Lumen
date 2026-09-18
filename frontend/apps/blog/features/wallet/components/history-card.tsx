'use client';

import { useState } from 'react';
import { useTranslation } from '@/blog/i18n/client';
import { EmptyStateIllustration } from '@/blog/components/empty-state-illustration';
import { useAccountHistory } from '../hooks/use-account-history';
import { getTransfersUrl } from '../lib/wallet-endpoint';
import { HISTORY_GROUPS, type HistoryGroup } from '../lib/history-groups';
import AccountHistoryRow from './account-history-row';

const CARD_CLASS = 'rounded-panel border border-line-9 bg-surface-1 p-5 sm:p-6';

/**
 * The Hive tab's activity list: three tabs, real pagination, one card.
 *
 * ★ SHARED BY THE PRIVATE AND PUBLIC WALLETS ON PURPOSE (2026-09-18). The two
 * pages used to hold byte-for-byte copies of this list, which is how the public
 * one kept its own stale bugs; the only real differences are the testid prefix
 * and one sentence of error copy, so those are props. Everything that decides
 * what a reader SEES — which operations each tab asks for, how "older" is
 * paged, what an empty tab says — has exactly one definition again.
 *
 * ★ THE TABS ARE SERVER-SIDE FILTERS, NOT A VIEW OVER ONE PAGE. "Rewards" asks
 * the chain for reward operations; it does not hide non-rewards out of the
 * newest 25. The difference is the whole point: an account whose last 25
 * operations are all transfers would otherwise be told it has never earned
 * anything.
 *
 * ★ "LOAD OLDER" IS A BUTTON, NOT AN INFINITE SCROLLER. This card sits above
 * nothing — it is the last thing on the wallet page — so an auto-loading
 * sentinel would keep fetching as long as somebody rests at the bottom of the
 * page, and on a phone that is most of the time. A button also gives the
 * reader somewhere to stop.
 */
export default function HistoryCard({
  username,
  testIdPrefix,
  errorKey
}: {
  username: string;
  /** `wallet-history` on the signed-in wallet, `public-history` on /@name/wallet. */
  testIdPrefix: string;
  /** i18n key for "we could not load this" — first person on your own wallet. */
  errorKey: string;
}) {
  const { t, i18n } = useTranslation('common_blog');
  const lang = i18n.resolvedLanguage ?? 'en';
  const [group, setGroup] = useState<HistoryGroup>('all');
  // ★ The rows arrive already described (2026-08-13) — see use-account-history.ts
  // and app/api/wallet/history/route.ts for why the describing had to move to the
  // server along with the chain reads it depends on.
  const { data, isLoading, isError, fetchNextPage, hasNextPage, isFetchingNextPage } = useAccountHistory(
    username,
    lang,
    group
  );
  const transfersUrl = getTransfersUrl(username);

  const entries = data?.pages.flatMap((page) => page.entries) ?? [];

  return (
    <section id="wallet-history" className="mt-6">
      <div className="mb-4 flex items-center gap-3.5">
        <span className="text-label font-medium uppercase tracking-label text-ink-14">
          {t('wallet.history.label')}
        </span>
        <div className="h-px flex-1 bg-surface-27" />
      </div>

      <div className={CARD_CLASS} data-testid={`${testIdPrefix}-card`}>
        {/* The wallet's own tab treatment, one size down (wallet-tabs.tsx):
            warm track, lit active pill. Buttons rather than Radix Tabs because
            all three tabs render the SAME panel — only the query behind it
            changes — so there is no content to mount and unmount.

            ★ THE DARK PAIR IS NOT OPTIONAL (measured 2026-09-18). `--lum-1` and
            `--amb-1` are hex strings with NO dark counterpart — deliberately,
            per globals.css — while `text-ink-2` DOES flip to near-white under
            `.dark`. Rendered, the active pill was rgb(253,251,250) text on a
            rgb(253,245,241) background: an invisible label. In dark the trough
            becomes the recess (`surface-23`) and the lit pill becomes the card
            surface (`surface-1`), which keeps "lifted paper on a trough" and
            lets `text-ink-2` read. The same two classes were missing on the
            wallet's own tab bars (wallet-tabs.tsx, public-wallet-tabs.tsx) and
            are fixed there too; the pattern is copied in seven other features
            that are NOT touched here. */}
        <div
          role="tablist"
          aria-label={t('wallet.history.groups.label')}
          className="mb-4 inline-flex flex-wrap items-center gap-1.5 rounded-xl border border-line-6 bg-[var(--amb-1)] p-[5px] dark:bg-surface-23"
          data-testid={`${testIdPrefix}-groups`}
        >
          {HISTORY_GROUPS.map((value) => {
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
                data-testid={`${testIdPrefix}-group-${value}`}
              >
                {t(`wallet.history.groups.${value}`)}
              </button>
            );
          })}
        </div>

        {isError ? (
          <p className="py-6 text-center text-[14px] leading-[22px] text-destructive" data-testid={`${testIdPrefix}-error`}>
            {t(errorKey)}
          </p>
        ) : isLoading ? (
          <p className="py-6 text-center text-[14px] leading-[22px] text-ink-14" data-testid={`${testIdPrefix}-loading`}>
            {t('wallet.history.loading')}
          </p>
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 text-center" data-testid={`${testIdPrefix}-empty`}>
            {/* ★ Drawn empty state (2026-08-18) — a new wallet with no history
                looked identical to a wallet that failed to load. The wording is
                per tab: "no transactions yet" is wrong on the Rewards tab of an
                account that transfers every day. */}
            <EmptyStateIllustration name="empty-wallet" size={104} />
            <p className="text-[14px] leading-[22px] text-ink-14">{t(`wallet.history.empty_${group}`)}</p>
          </div>
        ) : (
          <>
            {/* Rows are discrete 14px blocks (see activity-row.tsx), so they
                need a gap rather than the hairline they used to share. */}
            <div className="flex flex-col gap-2" data-testid={`${testIdPrefix}-rows`}>
              {entries.map((entry) => (
                <AccountHistoryRow key={entry.key} entry={entry} />
              ))}
            </div>
            <div className="mt-3 flex flex-col items-center gap-2 border-t border-line-2 pt-3">
              {hasNextPage ? (
                <button
                  type="button"
                  onClick={() => fetchNextPage()}
                  disabled={isFetchingNextPage}
                  className="lm-press rounded-card border border-line-11 px-4 py-2 text-caption font-medium text-ink-7 transition-colors hover:bg-surface-16 disabled:opacity-60"
                  data-testid={`${testIdPrefix}-load-more`}
                >
                  {isFetchingNextPage ? t('wallet.history.loading_older') : t('wallet.history.load_older')}
                </button>
              ) : (
                // ★ Says the list ENDED. Without this the last page looks
                // exactly like a page whose "Load older" button failed to
                // render, on the one screen where "is that everything?" is a
                // question about money.
                <p className="text-caption text-ink-14" data-testid={`${testIdPrefix}-end`}>
                  {t('wallet.history.end_of_history')}
                </p>
              )}
              {transfersUrl !== '#' ? (
                <a
                  href={transfersUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-caption font-medium text-ink-brand-6 hover:text-ink-brand-4"
                  data-testid={`${testIdPrefix}-view-more`}
                >
                  {t('wallet.history.view_full')}
                </a>
              ) : null}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
