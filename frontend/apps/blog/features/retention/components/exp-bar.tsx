'use client';

import { useTranslation } from '@/blog/i18n/client';
import { LeagueTier, type HabitProgress } from '../types';
import { TIERS } from '../lib/tiers';

// Duolingo-style horizontal EXP bar (HABIT layer). The fill is the TIER gradient
// or neutral ink — NEVER green or red (those mean payout / upvote). This is the
// personal, cosmetic "Summoner level"; it never feeds the league tier.

export interface ExpBarProps {
  habit: HabitProgress;
  tier: LeagueTier;
  className?: string;
  /**
   * Where the level/XP numbers came from. This component is currently unmounted
   * (the habit layer is hidden until a real task ledger exists) and is kept for
   * that future wiring — so it REFUSES to draw 'mock' data rather than quietly
   * showing every user the same invented level the day someone re-adds it.
   */
  habitSource?: 'mock' | 'server';
}

export function ExpBar({ habit, tier, className, habitSource }: ExpBarProps) {
  const { t } = useTranslation('common_blog');
  // Invented progress is not shown. Render nothing at all: a level bar is a
  // claim about the user's history, and a wrong one is worse than none.
  if (habitSource !== 'server') return null;
  const { level, xp, xpToNext } = habit;
  const total = xp + xpToNext;
  const pct = total > 0 ? Math.max(0, Math.min(100, (xp / total) * 100)) : 0;
  const { core, glow } = TIERS[tier].color;

  return (
    <div className={className}>
      <div className="flex items-baseline justify-between">
        <span className="font-sans text-[15px] font-semibold text-[#161511]">
          {t('retention.level', { n: level })}
        </span>
        <span className="text-[13px] tabular-nums text-[#6b7280]">
          {t('retention.xp_progress', { xp, total })}
        </span>
      </div>

      <div className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-[#f1f3f5]">
        <div
          className="h-full rounded-full transition-[width] duration-500 ease-out"
          style={{ width: `${pct}%`, background: `linear-gradient(90deg, ${core}, ${glow})` }}
        />
      </div>

      <p className="mt-1.5 text-[12px] tabular-nums text-[#9ca3af]">
        {t('retention.xp_to_next', { remaining: xpToNext, next: level + 1 })}
      </p>
    </div>
  );
}
