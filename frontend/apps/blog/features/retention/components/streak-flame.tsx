'use client';

import { Flame } from 'lucide-react';
import { cn } from '@ui/lib/utils';
import { useTranslation } from '@/blog/i18n/client';

// Streak indicator (HABIT layer). Amber when today's streak-ticking act is done,
// muted grey otherwise. NEVER red (red means downvote/removed value).

export interface StreakFlameProps {
  days: number;
  active: boolean;
  className?: string;
}

export function StreakFlame({ days, active, className }: StreakFlameProps) {
  const { t } = useTranslation('common_blog');
  const color = active ? 'text-amber-500' : 'text-[#9ca3af]';

  return (
    <div className={cn('inline-flex items-center gap-1.5', color, className)}>
      <Flame className="h-4 w-4 shrink-0" fill={active ? 'currentColor' : 'none'} aria-hidden="true" />
      <span className="text-[13px] font-medium tabular-nums">
        {t('retention.day_streak', { days })}
      </span>
    </div>
  );
}
