'use client';

import { useState } from 'react';
import Big from 'big.js';
import { Icons } from '@ui/components/icons';
import { Link, UserAvatarImg } from '@hive/ui';
import { useTranslation } from '@/blog/i18n/client';
import { useDelegations } from '../hooks/use-delegations';
import { getDelegationsUrl } from '../lib/wallet-endpoint';
import { formatTokenAmount } from '../lib/format-amount';

/**
 * "Delegated out" expandable bar + delegatee list. Mirrors the design's
 * `delegatedOpen` toggle state exactly — local useState, no page-level
 * lifting needed since nothing else reads it.
 */
export default function DelegatedOutPanel({
  username,
  delegatedOutHp
}: {
  username: string;
  delegatedOutHp: Big;
}) {
  const { t } = useTranslation('common_blog');
  const [delegatedOpen, setDelegatedOpen] = useState(false);
  const { data: delegatees } = useDelegations(username);

  return (
    <div className="flex flex-col gap-2.5">
      <button
        type="button"
        onClick={() => setDelegatedOpen((prev) => !prev)}
        // W-3: `rounded-xl` is 12px, a third radius on a page that also had 10px
        // and 11px controls. The system radius for a row is 14px.
        // ★ Preventive `flex-wrap` (2026-08-14): same "label" + unbreakable
        // tabular-nums figure across one non-wrapping row shape as the token
        // cards above it on this page. A large delegated-out total (exchange
        // accounts delegate 7-figure HP) plus the chevron could push past
        // this button's ~276px width (card padding + the section's own
        // border-l/pl-4 indent) the same way the reported bugs did.
        className="flex w-full flex-wrap items-center justify-between gap-x-2 gap-y-1 rounded-card border border-line-9 bg-surface-1 px-3.5 py-2.5 transition-colors hover:bg-surface-16"
        data-testid="wallet-delegated-out-toggle"
      >
        <span className="flex items-center gap-2.5 text-[14px] leading-[22px] font-semibold text-ink-7">
          <Icons.swap className="h-[15px] w-[15px] text-ink-14" />
          {t('wallet.delegated.out')}
        </span>
        <span className="flex items-center gap-2.5">
          <span className="font-sans text-[15px] leading-[24px] font-bold tabular-nums text-ink-brand-6">
            {/* ★ No sign at zero (2026-08-09). The minus was unconditional, so an
                account delegating nothing read "-0.000 HP" — a negative-looking
                figure for the absence of a thing. */}
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
        <div className="rounded-card border border-line-9 bg-surface-5 px-4 py-3.5" data-testid="wallet-delegated-out-list">
          <div className="mb-2.5 flex items-center justify-between">
            <span className="text-caption font-bold tabular-nums text-ink-4">
              {t('wallet.delegated.accounts_count', { count: delegatees?.length ?? 0 })}
            </span>
            <a
              href={getDelegationsUrl(username)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-caption font-semibold text-ink-brand-6 hover:text-ink-brand-4"
              data-testid="wallet-manage-delegations"
            >
              {t('wallet.delegated.manage')}
            </a>
          </div>
          {delegatees && delegatees.length > 0 ? (
            <div className="flex flex-col gap-0.5">
              {delegatees.map((d) => (
                <div
                  key={d.name}
                  className="flex items-center justify-between gap-2.5 border-t border-line-2 py-1.5 first:border-t-0"
                >
                  <Link
                    href={`/@${d.name}`}
                    className="flex min-w-0 items-center gap-2.5 text-[14px] leading-[22px] text-ink-4 hover:text-ink-brand-6"
                    data-testid="wallet-delegated-out-account"
                  >
                    {/* ★ CONVERGED (F6 item 22). No fallback before. */}
                    <UserAvatarImg username={d.name} pixelSize={24} />
                    <span className="truncate">@{d.name}</span>
                  </Link>
                  <span className="shrink-0 font-sans text-[14px] leading-[22px] font-semibold tabular-nums text-ink-7">
                    {d.hp} HP
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-caption text-ink-14">{t('wallet.delegated.none')}</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
