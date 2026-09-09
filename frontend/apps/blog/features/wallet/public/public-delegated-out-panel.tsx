'use client';

import { useState } from 'react';
import Big from 'big.js';
import { Icons } from '@ui/components/icons';
import { Link, UserAvatarImg } from '@hive/ui';
import { useTranslation } from '@/blog/i18n/client';
import { useDelegations } from '@/blog/features/wallet/hooks/use-delegations';
import { formatTokenAmount } from '@/blog/features/wallet/lib/format-amount';

/**
 * Read-only copy of features/wallet/components/delegated-out-panel.tsx for
 * the public wallet page. Removed: the Manage delegations link out to the
 * standalone wallet app. That page needs the account's own session, so it is
 * wrong to offer on someone else's wallet. Same expand toggle and the same
 * error, loading, empty ordering the original documents, since a failed
 * read must never be shown as an honest empty state.
 *
 * Test ids below say "outgoing", not "delegated", on purpose: this panel has
 * no delegate action left on it (S1 forbids a signing testid anywhere on
 * this page), it only displays a fact that is already public on chain.
 */
export default function PublicDelegatedOutPanel({
  username,
  delegatedOutHp
}: {
  username: string;
  delegatedOutHp: Big;
}) {
  const { t } = useTranslation('common_blog');
  const [delegatedOpen, setDelegatedOpen] = useState(false);
  const { data: delegatees, isFetching, isError } = useDelegations(username);
  const isPending = isFetching && !delegatees;

  return (
    <div className="flex flex-col gap-2.5">
      <button
        type="button"
        onClick={() => setDelegatedOpen((prev) => !prev)}
        className="flex w-full flex-wrap items-center justify-between gap-x-2 gap-y-1 rounded-card border border-line-9 bg-surface-1 px-3.5 py-2.5 transition-colors hover:bg-surface-16"
        data-testid="public-outgoing-hp-toggle"
      >
        <span className="flex items-center gap-2.5 text-[14px] leading-[22px] font-medium text-ink-7">
          <Icons.swap className="h-[15px] w-[15px] text-ink-14" />
          {t('wallet.delegated.out')}
        </span>
        <span className="flex items-center gap-2.5">
          <span className="font-num font-medium text-[15px] leading-[24px] text-ink-brand-6">
            {delegatedOutHp.gt(0) ? '-' : ''}
            {formatTokenAmount(delegatedOutHp)} HP
          </span>
          {delegatedOpen ? (
            <Icons.chevronUp className="h-3.5 w-3.5 text-ink-14" />
          ) : (
            <Icons.chevronDown className="h-3.5 w-3.5 text-ink-14" />
          )}
        </span>
      </button>

      {delegatedOpen ? (
        <div className="rounded-card border border-line-9 bg-surface-5 px-4 py-3.5" data-testid="public-outgoing-hp-list">
          <div className="mb-2.5 flex items-center justify-between">
            <span className="text-caption font-medium tabular-nums text-ink-4">
              {delegatees
                ? t('wallet.delegated.accounts_count', { count: delegatees.length })
                : t('wallet.delegated.out')}
            </span>
          </div>
          {isError ? (
            <p className="text-caption text-destructive" data-testid="public-outgoing-hp-error">
              {t('wallet.public.delegated_error')}
            </p>
          ) : isPending ? (
            <p className="text-caption text-ink-14" data-testid="public-outgoing-hp-loading">
              {t('wallet.public.delegated_loading')}
            </p>
          ) : delegatees && delegatees.length > 0 ? (
            <div className="flex flex-col gap-0.5">
              {delegatees.map((d) => (
                <div
                  key={d.name}
                  className="flex items-center justify-between gap-2.5 border-t border-line-2 py-1.5 first:border-t-0"
                >
                  <Link
                    href={`/@${d.name}`}
                    className="flex min-w-0 items-center gap-2.5 text-[14px] leading-[22px] text-ink-4 hover:text-ink-brand-6"
                    data-testid="public-outgoing-hp-account"
                  >
                    <UserAvatarImg username={d.name} pixelSize={24} />
                    <span className="truncate">@{d.name}</span>
                  </Link>
                  <span className="shrink-0 font-num font-medium text-[14px] leading-[22px] text-ink-7">
                    {d.hp} HP
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-caption text-ink-14" data-testid="public-outgoing-hp-empty">
              {t('wallet.public.delegated_none')}
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}
