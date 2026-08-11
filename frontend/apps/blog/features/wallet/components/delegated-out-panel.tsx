'use client';

import { useState } from 'react';
import Big from 'big.js';
import { ChevronDown, ChevronUp, Repeat } from 'lucide-react';
import { Link, UserAvatarImg } from '@hive/ui';
import { useTranslation } from '@/blog/i18n/client';
import { useDelegations } from '../hooks/use-delegations';
import { getDelegationsUrl } from '../lib/wallet-endpoint';
import { formatTokenAmount } from '../lib/format-amount';
import { GetDynamicGlobalPropertiesResponse } from '@hiveio/wax';
import { Chain } from '@transaction/lib/chain';

/**
 * "Delegated out" expandable bar + delegatee list. Mirrors the design's
 * `delegatedOpen` toggle state exactly — local useState, no page-level
 * lifting needed since nothing else reads it.
 */
export default function DelegatedOutPanel({
  username,
  delegatedOutHp,
  dynamicGlobal,
  chain
}: {
  username: string;
  delegatedOutHp: Big;
  dynamicGlobal: GetDynamicGlobalPropertiesResponse | null;
  chain: Chain | null;
}) {
  const { t } = useTranslation('common_blog');
  const [delegatedOpen, setDelegatedOpen] = useState(false);
  const { data: delegatees } = useDelegations(username, dynamicGlobal, chain);

  return (
    <div className="flex flex-col gap-2.5">
      <button
        type="button"
        onClick={() => setDelegatedOpen((prev) => !prev)}
        // W-3: `rounded-xl` is 12px, a third radius on a page that also had 10px
        // and 11px controls. The system radius for a row is 14px.
        className="flex w-full items-center justify-between rounded-[14px] border border-[#ebebeb] bg-white px-3.5 py-2.5 transition-colors hover:bg-[#f6f7f8]"
        data-testid="wallet-delegated-out-toggle"
      >
        <span className="flex items-center gap-2.5 text-[13.5px] font-semibold text-[#3f4650]">
          <Repeat className="h-[15px] w-[15px] text-[#9ca3af]" />
          {t('wallet.delegated.out')}
        </span>
        <span className="flex items-center gap-2.5">
          <span className="font-sans text-[15px] font-bold tabular-nums text-[#c0392b]">
            {/* ★ No sign at zero (2026-08-09). The minus was unconditional, so an
                account delegating nothing read "-0.000 HP" — a negative-looking
                figure for the absence of a thing. */}
            {delegatedOutHp.gt(0) ? '-' : ''}
            {formatTokenAmount(delegatedOutHp)} HP
          </span>
          {delegatedOpen ? (
            <ChevronUp className="h-3.5 w-3.5 text-[#9ca3af]" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 text-[#9ca3af]" />
          )}
        </span>
      </button>

      {delegatedOpen ? (
        <div className="rounded-[14px] border border-[#ebebeb] bg-[#fbfbfa] px-4 py-3.5" data-testid="wallet-delegated-out-list">
          <div className="mb-2.5 flex items-center justify-between">
            <span className="text-[13px] font-bold text-[#2a2822]">
              {t('wallet.delegated.accounts_count', { count: delegatees?.length ?? 0 })}
            </span>
            <a
              href={getDelegationsUrl(username)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[12.5px] font-semibold text-[#c0392b] hover:text-[#96271b]"
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
                  className="flex items-center justify-between gap-2.5 border-t border-[#f1f3f5] py-1.5 first:border-t-0"
                >
                  <Link
                    href={`/@${d.name}`}
                    className="flex min-w-0 items-center gap-2.5 text-[13.5px] text-[#2a2822] hover:text-[#c0392b]"
                    data-testid="wallet-delegated-out-account"
                  >
                    {/* ★ CONVERGED (F6 item 22). No fallback before. */}
                    <UserAvatarImg username={d.name} pixelSize={24} />
                    <span className="truncate">@{d.name}</span>
                  </Link>
                  <span className="shrink-0 font-sans text-[13.5px] font-semibold tabular-nums text-[#3f4650]">
                    {d.hp} HP
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[13px] text-[#9ca3af]">{t('wallet.delegated.none')}</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
