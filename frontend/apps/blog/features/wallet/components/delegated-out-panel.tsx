'use client';

import { useState } from 'react';
import Big from 'big.js';
import { ChevronDown, ChevronUp, Repeat } from 'lucide-react';
import { useTranslation } from '@/blog/i18n/client';
import { useDelegations } from '../hooks/use-delegations';
import { getDelegationsUrl } from '../lib/wallet-endpoint';
import { formatTokenAmount } from '../lib/format-amount';
import { GetDynamicGlobalPropertiesResponse } from '@hiveio/wax';
import { Chain } from '@transaction/lib/chain';

const AVATAR_COLORS = ['#2f7d4f', '#3182ce', '#805ad5', '#c0392b', '#e0b24d'];

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
        className="flex w-full items-center justify-between rounded-xl border border-[#ebebeb] bg-white px-3.5 py-2.5 transition-colors hover:bg-[#f6f7f8]"
        data-testid="wallet-delegated-out-toggle"
      >
        <span className="flex items-center gap-2.5 text-[13.5px] font-semibold text-[#3f4650]">
          <Repeat className="h-[15px] w-[15px] text-[#9ca3af]" />
          {t('wallet.delegated.out')}
        </span>
        <span className="flex items-center gap-2.5">
          <span className="font-sans text-[15px] font-bold tabular-nums text-[#c0392b]">
            -{formatTokenAmount(delegatedOutHp)} HP
          </span>
          {delegatedOpen ? (
            <ChevronUp className="h-3.5 w-3.5 text-[#9ca3af]" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 text-[#9ca3af]" />
          )}
        </span>
      </button>

      {delegatedOpen ? (
        <div className="rounded-xl border border-[#ebebeb] bg-[#fbfbfa] px-4 py-3.5" data-testid="wallet-delegated-out-list">
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
              {delegatees.map((d, i) => (
                <div
                  key={d.name}
                  className="flex items-center justify-between border-t border-[#f1f3f5] py-1.5 first:border-t-0"
                >
                  <span className="flex items-center gap-2.5 text-[13.5px] text-[#2a2822]">
                    <span
                      className="h-6 w-6 rounded-full"
                      style={{ background: AVATAR_COLORS[i % AVATAR_COLORS.length] }}
                    />
                    @{d.name}
                  </span>
                  <span className="font-sans text-[13.5px] font-semibold tabular-nums text-[#3f4650]">
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
