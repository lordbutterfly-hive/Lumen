'use client';

import { Popover, PopoverContent, PopoverTrigger } from '@ui/components/popover';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useTranslation } from '@/blog/i18n/client';
import { ManabarRing } from '@/blog/features/layouts/site-header/manabar-ring';
import { LeagueEmblem, divisionToRoman } from '../emblems/league-emblem';
import { TIERS } from '../lib/tiers';
import { useRetention } from '../hooks/use-retention';
import { StreakFlame } from './streak-flame';

// The navbar/left-rail status block: a calm emblem + thin ring + tier name.
// The ring color is the TIER core (never green/red) and its fill is the real,
// chain-derived `rank.standing` Standing Score. Click opens a Radix popover
// card with the big emblem, tier/division, and the streak flame. Rendered
// only when logged in.
//
// PRODUCT DECISION (2026-07-30, FRONTEND-REMAINING-2026-07-30.md row 1.3): the
// HABIT layer (Level/XP/daily-tasks) has no real backend — `use-retention.ts`
// only overwrites `streakDays`/`activeWeeks` from the server, the rest is
// `mockSummary()`'s hardcoded constants for every user, forever. Rather than
// invent an XP economy, that entire layer is hidden here (Lv pill, EXP bar,
// Daily 5 checklist all removed from this component) until a real task ledger
// exists. `exp-bar.tsx` / `daily-tasks-popover-content.tsx` are kept, unused,
// for that future wiring — do not re-add them without a real data source.

export function LeagueShowcase() {
  const { user } = useUserClient();
  const { t } = useTranslation('common_blog');
  const { data: summary } = useRetention(user.username);

  if (!user.isLoggedIn || !summary) return null;

  const { rank, habit } = summary;
  const info = TIERS[rank.tier];
  const tierName = t(info.labelKey);
  const ringPct = Math.max(0, Math.min(100, rank.standing));
  // `habit.streakDays` is real (server-overwritten in use-retention.ts); the
  // per-task "ticked today" flag is not, so the flame's lit/unlit state is
  // driven by the honest streak count instead.
  const streakActive = habit.streakDays > 0;
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
              <span className="truncate font-sans text-[14px] font-semibold text-[#161511]">{tierName}</span>
              {divisionLabel && (
                <span className="w-fit rounded-full bg-[#f1f3f5] px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-[#4b5563]">
                  {divisionLabel}
                </span>
              )}
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
        </PopoverContent>
      </Popover>
    </li>
  );
}
