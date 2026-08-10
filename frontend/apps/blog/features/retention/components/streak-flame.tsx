'use client';

import { Flame } from 'lucide-react';
import { cn } from '@ui/lib/utils';
import { useTranslation } from '@/blog/i18n/client';

// Streak indicator (HABIT layer). Amber when today's streak-ticking act is done,
// muted grey otherwise. NEVER red (red means downvote/removed value).

export interface StreakFlameProps {
  days: number;
  active: boolean;
  /**
   * ★ The run was still unbroken where the server stopped reading history, so
   * `days` is a FLOOR. Renders "N+ day streak" instead of a bare N — the same
   * honesty rule `activeWeeksIsLowerBound` already gets, applied to the number
   * right beside it. The chain route publishes this as
   * `provenance.coverage.streakDaysIsLowerBound`; it was being computed and then
   * thrown away by every consumer, so a 32-day floor read as a 32-day
   * measurement.
   */
  isLowerBound?: boolean;
  className?: string;
}

export function StreakFlame({ days, active, isLowerBound = false, className }: StreakFlameProps) {
  const { t } = useTranslation('common_blog');
  const color = active ? 'text-amber-500' : 'text-[#9ca3af]';
  const label = isLowerBound ? t('retention.day_streak_at_least', { days }) : t('retention.day_streak', { days });

  return (
    <div className={cn('inline-flex items-center gap-1.5', color, className)} data-testid="retention-streak-flame">
      <Flame className="h-4 w-4 shrink-0" fill={active ? 'currentColor' : 'none'} aria-hidden="true" />
      <span className="text-[13px] font-medium tabular-nums" title={isLowerBound ? t('retention.day_streak_floor_hint') : undefined}>
        {label}
      </span>
    </div>
  );
}
