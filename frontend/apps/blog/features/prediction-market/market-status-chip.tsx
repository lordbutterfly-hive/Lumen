'use client';

import { cn } from '@ui/lib/utils';
import { useTranslation } from '@/blog/i18n/client';
import type { MarketStatus } from './types';

// Coinbase-style status badge on the Lumen light palette. `open` = the green
// "LIVE" pill with a glowing dot ring (design token #e9f5ee / #2f7d4f). Other
// lifecycle states reuse the same shape in muted/amber/red.
type StatusConfig = { label: string; textClass: string; pillBgClass: string; dotClass: string; ring?: boolean };

export default function MarketStatusChip({
  status,
  variant = 'pill'
}: {
  status: MarketStatus;
  variant?: 'pill' | 'bare';
}) {
  const { t } = useTranslation('common_blog');

  const CONFIG: Record<MarketStatus, StatusConfig> = {
    open: { label: t('prediction_market.status.live'), textClass: 'text-ink-ok-2', pillBgClass: 'bg-surface-ok-5', dotClass: 'bg-surface-ok-7', ring: true },
    locked: { label: t('prediction_market.status.locked'), textClass: 'text-ink-warn-3', pillBgClass: 'bg-surface-warn-6', dotClass: 'bg-surface-warn-11' },
    settled: { label: t('prediction_market.status.settled'), textClass: 'text-ink-10', pillBgClass: 'bg-surface-23', dotClass: 'bg-surface-34' },
    void: { label: t('prediction_market.status.void'), textClass: 'text-ink-brand-6', pillBgClass: 'bg-surface-brand-7', dotClass: 'bg-surface-brand-12' }
  };
  const config = CONFIG[status];

  if (variant === 'bare') {
    return (
      <span className={cn('inline-flex items-center gap-[5px] text-[12px] leading-[18px] font-bold', config.textClass)}>
        <span className={cn('h-1.5 w-1.5 rounded-full', config.dotClass)} aria-hidden="true" />
        {config.label}
      </span>
    );
  }

  return (
    <span
      className={cn(
        'inline-flex flex-shrink-0 items-center gap-[7px] rounded-full px-[13px] py-[7px] text-[13px] leading-[20px] font-bold',
        config.pillBgClass,
        config.textClass
      )}
    >
      <span
        className={cn(
          'h-[7px] w-[7px] rounded-full',
          config.dotClass,
          config.ring && 'shadow-[0_0_0_3px_rgba(47,125,79,0.18)]'
        )}
        aria-hidden="true"
      />
      {config.label}
    </span>
  );
}
