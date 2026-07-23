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
    open: { label: t('prediction_market.status.live'), textClass: 'text-[#2f7d4f]', pillBgClass: 'bg-[#e9f5ee]', dotClass: 'bg-[#2f7d4f]', ring: true },
    locked: { label: t('prediction_market.status.locked'), textClass: 'text-[#b45309]', pillBgClass: 'bg-[#fdf3e7]', dotClass: 'bg-[#b45309]' },
    settled: { label: t('prediction_market.status.settled'), textClass: 'text-[#6b7280]', pillBgClass: 'bg-[#f1f3f5]', dotClass: 'bg-[#9ca3af]' },
    void: { label: t('prediction_market.status.void'), textClass: 'text-[#c0392b]', pillBgClass: 'bg-[#fdecea]', dotClass: 'bg-[#c0392b]' }
  };
  const config = CONFIG[status];

  if (variant === 'bare') {
    return (
      <span className={cn('inline-flex items-center gap-[5px] text-[11px] font-bold', config.textClass)}>
        <span className={cn('h-1.5 w-1.5 rounded-full', config.dotClass)} aria-hidden="true" />
        {config.label}
      </span>
    );
  }

  return (
    <span
      className={cn(
        'inline-flex flex-shrink-0 items-center gap-[7px] rounded-full px-[13px] py-[7px] text-[12.5px] font-bold',
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
