'use client';

import { Flame } from 'lucide-react';
import { cn } from '@ui/lib/utils';
import { useTranslation } from '@/blog/i18n/client';

// Streak indicator. Amber while the streak is alive, muted grey at zero. NEVER red
// (red means downvote / removed value everywhere else in this product).
//
// ★ `days` IS NOT A RUN OF CONSECUTIVE DAYS ANY MORE (2026-08-18). It is the decaying
// score: +1 for a day with an authored act, -2 for a day without one, floored at zero
// (compute-streak.ts). The word "streak" survives because that is what the owner and
// every reader calls it; the arithmetic behind it is on the `title` below, because a
// number that can go DOWN has to say so wherever it is shown.

export interface StreakFlameProps {
  days: number;
  active: boolean;
  /**
   * ★ The decay could not be accumulated all the way back to the day Lumen started
   * counting this account, so `days` is a FLOOR. Renders "N+ day streak" instead of a
   * bare N — the same honesty rule `activeWeeksIsLowerBound` already gets, applied to
   * the number right beside it. Clamping at zero makes the accumulation monotone in its
   * starting value, so an unread stretch of history could only ever have made the number
   * BIGGER. The chain route publishes this as
   * `provenance.coverage.streakDaysIsLowerBound`; it was being computed and then thrown
   * away by every consumer, so a 32-day floor read as a 32-day measurement.
   */
  isLowerBound?: boolean;
  className?: string;
}

export function StreakFlame({ days, active, isLowerBound = false, className }: StreakFlameProps) {
  const { t } = useTranslation('common_blog');
  const color = active ? 'text-ink-warn-10' : 'text-ink-14';
  const label = isLowerBound ? t('retention.day_streak_at_least', { days }) : t('retention.day_streak', { days });

  return (
    <div className={cn('inline-flex items-center gap-1.5', color, className)} data-testid="retention-streak-flame">
      <Flame className="h-4 w-4 shrink-0" fill={active ? 'currentColor' : 'none'} aria-hidden="true" />
      <span
        className="text-caption font-medium tabular-nums"
        title={isLowerBound ? t('retention.day_streak_floor_hint') : t('retention.day_streak_hint')}
      >
        {label}
      </span>
    </div>
  );
}
