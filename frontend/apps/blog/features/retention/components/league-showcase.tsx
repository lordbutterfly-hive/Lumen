'use client';

import { useEffect } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@ui/components/popover';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useTranslation } from '@/blog/i18n/client';
import { useAppStore } from '@/blog/store/app';
import { ManabarRing } from '@/blog/features/layouts/site-header/manabar-ring';
import { LeagueEmblem, divisionToRoman } from '../emblems/league-emblem';
import { TIERS } from '../lib/tiers';
import { useRetention } from '../hooks/use-retention';
import { ExpBar } from './exp-bar';
import { StreakFlame } from './streak-flame';
import { DailyTasksPopoverContent } from './daily-tasks-popover-content';

// The navbar/left-rail status block: a calm emblem + thin XP ring + tier name +
// neutral "Lv" pill. The XP ring color is the TIER core (never green/red). Click
// opens a Radix popover card with the big emblem, tier/division, the EXP bar,
// the streak flame, and the Daily 5 checklist. Rendered only when logged in.

export function LeagueShowcase() {
  const { user } = useUserClient();
  const hydrateRetention = useAppStore((s) => s.hydrateRetention);
  const { t } = useTranslation('common_blog');
  const { data: summary } = useRetention(user.username);

  useEffect(() => {
    hydrateRetention();
  }, [hydrateRetention]);

  if (!user.isLoggedIn || !summary) return null;

  const { rank, habit, tasks } = summary;
  const info = TIERS[rank.tier];
  const tierName = t(info.labelKey);
  const total = habit.xp + habit.xpToNext;
  const ringPct = total > 0 ? (habit.xp / total) * 100 : 0;
  const streakActive = tasks.some((task) => task.ticksStreak && task.done);
  const divisionLabel = info.hasDivisions && rank.division ? divisionToRoman(rank.division) : null;

  return (
    <li className="px-1 pb-2">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="league-showcase-trigger"
            className="flex w-full items-center gap-2.5 rounded-xl px-[10px] py-2 text-left transition-colors hover:bg-[#f1f3f5]"
          >
            <span className="relative inline-flex shrink-0 items-center justify-center">
              <ManabarRing percentage={ringPct} color={info.color.core} size={34} thickness={3} />
              <span className="absolute inset-0 flex items-center justify-center">
                <LeagueEmblem tier={rank.tier} division={rank.division} size="nav" />
              </span>
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-sans text-[14px] font-semibold text-[#161511]">
                {tierName}
              </span>
              <span className="w-fit rounded-full bg-[#f1f3f5] px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-[#4b5563]">
                {t('retention.level_pill', { n: habit.level })}
              </span>
            </span>
          </button>
        </PopoverTrigger>

        <PopoverContent
          side="right"
          align="start"
          className="w-[320px] rounded-[18px] border border-[#ebebeb] bg-white p-5 text-[#161511] shadow-lg"
        >
          <div className="flex items-center gap-3">
            <LeagueEmblem tier={rank.tier} division={rank.division} size="popover" />
            <div className="min-w-0">
              <p className="font-sans text-[17px] font-semibold leading-tight">
                {tierName}
                {divisionLabel && <span className="ml-1.5 tabular-nums text-[#6b7280]">{divisionLabel}</span>}
              </p>
              <StreakFlame days={habit.streakDays} active={streakActive} className="mt-1" />
            </div>
          </div>

          <ExpBar habit={habit} tier={rank.tier} className="mt-4" />

          <div className="mt-4 border-t border-[#f1f3f5] pt-4">
            <DailyTasksPopoverContent tasks={tasks} />
          </div>
        </PopoverContent>
      </Popover>
    </li>
  );
}
