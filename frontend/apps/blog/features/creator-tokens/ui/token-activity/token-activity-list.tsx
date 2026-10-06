'use client';

import { useMemo, useState } from 'react';
import { Link } from '@hive/ui';
import { useTranslation } from '@/blog/i18n/client';
import { EmptyStateIllustration } from '@/blog/components/empty-state-illustration';
import ActivityRow from '@/blog/features/wallet/components/activity-row';
import { magiExplorerTxUrl } from '@/blog/features/wallet/lib/magi-history';
import { getCreatorTokensConfig, getCreatorTokensDataSource } from '../../lib/creator-tokens-data-source';
import { useTokenActivity } from '../../live/use-token-activity';
import {
  TOKEN_ACTIVITY_GROUPS,
  describeTokenActivity,
  displayTokenAccount,
  tokenAccountHref,
  type ActivityLabelPart,
  type TokenActivityEntry,
  type TokenActivityGroup,
  type TokenActivityScope,
  type TokenActivityView
} from '../../lib/vsc/token-activity';

/**
 * Staged copy, same precedent as the rest of this feature (meritum-copy.ts).
 * Plain words: "Send & receive" is the Hive tab's own word for the same tab.
 */
const GROUP_LABELS: Record<TokenActivityGroup, string> = { all: 'All', transfers: 'Send & receive', trades: 'Buy & sell', orders: 'Orders' };
const PAGE_EMPTY: Record<TokenActivityGroup, string> = {
  all: 'No transactions yet',
  transfers: 'Nobody has sent this token yet',
  trades: 'No buys or sells yet',
  orders: 'No orders yet'
};
const WALLET_EMPTY: Record<TokenActivityGroup, string> = {
  all: 'No Meritum activity yet',
  transfers: 'Nothing sent or received yet',
  trades: 'Nothing bought or sold yet',
  orders: 'No orders yet'
};
const COPY = {
  groups: GROUP_LABELS,
  groupsLabel: 'Filter transactions',
  loading: 'Loading transactions…',
  page: {
    title: 'Transactions',
    error: 'Couldn’t load the transactions just now.',
    empty: PAGE_EMPTY
  },
  wallet: {
    title: 'Your Meritum activity',
    error: 'Couldn’t load your Meritum activity just now. Nothing is wrong with your tokens.',
    empty: WALLET_EMPTY
  }
};

function AccountName({ account }: { account: string }) {
  const href = tokenAccountHref(account);
  const label = displayTokenAccount(account);
  return href ? (
    <Link href={href} className="font-medium text-ink-4 hover:underline" data-testid="token-activity-account">
      {label}
    </Link>
  ) : (
    <span className="font-mono font-medium text-ink-4" data-testid="token-activity-account">
      {label}
    </span>
  );
}

function Label({ parts }: { parts: ActivityLabelPart[] }) {
  return (
    <>
      {parts.map((part, i) => ('account' in part ? <AccountName key={i} account={part.account} /> : <span key={i}>{part.text}</span>))}
    </>
  );
}

/**
 * Who sent what, how much, to whom: a token's movements on its creator page
 * (owner, 2026-10-06: "underneath the holders the transactions that happened
 * for that token ... check how we show hive"), and one reader's own movements
 * on the wallet's Meritum tab.
 *
 * ★ THE HIVE WALLET'S LIST, NOT A NEW ONE. Same row (`activity-row.tsx`: the
 * category tile, the absolute date, the explorer link, the signed amount), same
 * tab bar, same "Load older" / "That is the whole history." footer, same
 * loading, error and drawn empty states as the Hive and Magi tabs. What differs
 * is only where the rows come from (the indexer's event tables, see
 * token-activity.ts) and, on the creator page, the section's own card and
 * heading, so it sits beside Holders as one of the page's sections.
 *
 * ★ ON THE CREATOR PAGE, NOTHING YET = NO SECTION (the page's "drop, don't
 * zero" rule: the holders section is not rendered when nobody holds). Before
 * the first answer it renders nothing either, as Holders does, so the section
 * never flashes in and back out. A FAILED read is shown, never hidden: it is a
 * different fact from "nothing happened".
 */
export default function TokenActivityList({
  scope,
  variant,
  accountLabel
}: {
  /** Ledger ids or bare Hive names; the data source normalises them. Null = nothing to read yet. */
  scope: TokenActivityScope | null;
  variant: 'page' | 'wallet';
  /** Wallet only: which account this list is, shown when the reader holds more than one. */
  accountLabel?: string;
}) {
  const { t, i18n } = useTranslation('common_blog');
  const lang = i18n.resolvedLanguage ?? 'en';
  const [group, setGroup] = useState<TokenActivityGroup>('all');
  const netId = getCreatorTokensConfig()?.netId ?? null;
  const { data, isLoading, isError, fetchNextPage, hasNextPage, isFetchingNextPage } = useTokenActivity(scope, group);
  const copy = variant === 'page' ? COPY.page : COPY.wallet;
  const testIdPrefix = variant === 'page' ? 'meritum-transactions' : 'wallet-meritum-activity';

  // Keyed on the scope's VALUES, so a caller may pass a fresh object literal.
  const scopeKind = scope?.kind ?? null;
  const scopeId = scope ? (scope.kind === 'token' ? scope.creator : scope.account) : '';
  const view: TokenActivityView | null = useMemo(() => {
    if (scopeKind === null) return null;
    if (scopeKind === 'token') return { kind: 'token' };
    // The reader's own ledger id, the form every log names accounts by.
    const account = scopeId.startsWith('hive:') || scopeId.startsWith('did:') ? scopeId : `hive:${scopeId}`;
    return { kind: 'account', account };
  }, [scopeKind, scopeId]);

  const entries = useMemo(() => {
    if (!view) return [];
    const byKey = new Map<string, TokenActivityEntry>();
    for (const page of data?.pages ?? []) {
      for (const event of page.events) {
        const entry = describeTokenActivity(event, view);
        if (!byKey.has(entry.key)) byKey.set(entry.key, entry);
      }
    }
    return [...byKey.values()];
  }, [data, view]);

  // ★ Not provisioned = render nothing. The query is disabled then, and React
  // Query v4 reports a disabled query with no data as `isLoading` for ever, so
  // this list would otherwise say "Loading…" on a build where the panel above
  // already says Meritum is not available.
  if (!scope || getCreatorTokensDataSource() === null) return null;
  if (variant === 'page' && group === 'all' && !isError && (isLoading || entries.length === 0)) return null;

  const tabs = (
    <div
      role="tablist"
      aria-label={COPY.groupsLabel}
      className="inline-flex flex-wrap items-center gap-1.5 rounded-xl border border-line-6 bg-[var(--amb-1)] p-[5px] dark:bg-surface-23"
      data-testid={`${testIdPrefix}-groups`}
    >
      {TOKEN_ACTIVITY_GROUPS.map((value) => {
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
            {COPY.groups[value]}
          </button>
        );
      })}
    </div>
  );

  const body = isError ? (
    <p className="py-6 text-center text-[14px] leading-[22px] text-destructive" data-testid={`${testIdPrefix}-error`}>
      {copy.error}
    </p>
  ) : isLoading ? (
    <p className="py-6 text-center text-[14px] leading-[22px] text-ink-14" data-testid={`${testIdPrefix}-loading`}>
      {COPY.loading}
    </p>
  ) : entries.length === 0 ? (
    <div className="flex flex-col items-center gap-2 py-8 text-center" data-testid={`${testIdPrefix}-empty`}>
      <EmptyStateIllustration name="empty-wallet" size={104} />
      <p className="text-[14px] leading-[22px] text-ink-14">{copy.empty[group]}</p>
    </div>
  ) : (
    <>
      <div className="flex flex-col gap-2" data-testid={`${testIdPrefix}-rows`}>
        {entries.map((entry) => (
          <ActivityRow
            key={entry.key}
            category={entry.category}
            tone={entry.tone}
            timestamp={entry.timestamp}
            amountText={entry.amountText}
            noAmountText={t('wallet.history.no_amount')}
            memo={entry.detail}
            href={magiExplorerTxUrl(entry.txId, netId)}
            hrefLabel={t('wallet.magi.history.view_on_explorer')}
            lang={lang}
            testId={`${testIdPrefix}-row`}
            label={<Label parts={entry.label} />}
          />
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
          <p className="text-caption text-ink-14" data-testid={`${testIdPrefix}-end`}>
            {t('wallet.history.end_of_history')}
          </p>
        )}
      </div>
    </>
  );

  if (variant === 'page') {
    return (
      <section className="rounded-[14px] border border-line-9 bg-surface-1 p-[26px]" data-testid={testIdPrefix}>
        <div className="mb-[18px] flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <h2 className="font-lora text-[22px] leading-[30px] font-semibold tracking-[-0.01em] text-ink-2">{copy.title}</h2>
          {tabs}
        </div>
        {body}
      </section>
    );
  }

  return (
    <div className="mt-6 rounded-panel border border-line-9 bg-surface-1 p-5 sm:p-6" data-testid={testIdPrefix}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div>
          <div className="text-[16px] leading-[24px] font-semibold text-ink-2">{copy.title}</div>
          {accountLabel ? (
            <div className="font-ui text-caption text-ink-10" data-testid={`${testIdPrefix}-account`}>
              {accountLabel}
            </div>
          ) : null}
        </div>
        {tabs}
      </div>
      {body}
    </div>
  );
}
