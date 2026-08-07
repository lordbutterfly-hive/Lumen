'use client';

import { useTranslation } from '@/blog/i18n/client';
import { LeagueEmblem, divisionToRoman } from '../emblems/league-emblem';
import { TIERS } from '../lib/tiers';
import { useRetention } from '../hooks/use-retention';

// Profile status-hero card — LEAGUE layer only (no XP / streak here). Shows the
// large emblem (animated for the Celestial apex), tier + division, tenure, and
// an honest 3-meter "what's gating your next promotion" breakdown so the path to
// status reads as "be valued," not "post more." Meter fills use the TIER color
// (never green/red — those mean payout/upvote).

export interface ProfileLeagueCardProps {
  username: string;
  /** False for a Lumen lite account: it has no chain tenure to look up. */
  chainAccount?: boolean;

  className?: string;
}

interface GateMeterProps {
  label: string;
  value: number; // 0..1
  core: string;
  glow: string;
}

function GateMeter({ label, value, core, glow }: GateMeterProps) {
  const pct = Math.max(0, Math.min(100, value * 100));
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-[13px] text-[#4b5563]">{label}</span>
        <span className="text-[12px] tabular-nums text-[#9ca3af]">{Math.round(pct)}%</span>
      </div>
      <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-[#f1f3f5]">
        <div
          className="h-full rounded-full transition-[width] duration-500 ease-out"
          style={{ width: `${pct}%`, background: `linear-gradient(90deg, ${core}, ${glow})` }}
        />
      </div>
    </div>
  );
}

export function ProfileLeagueCard({ username, className, chainAccount = true }: ProfileLeagueCardProps) {
  const { t } = useTranslation('common_blog');
  const { data: summary } = useRetention(username, chainAccount);

  if (!summary) return null;

  const { rank, tenureYear, gate } = summary;
  const info = TIERS[rank.tier];
  const { core, glow } = info.color;
  const tierName = t(info.labelKey);
  const divisionLabel = info.hasDivisions && rank.division ? divisionToRoman(rank.division) : null;

  return (
    <section
      className={`rounded-[18px] border border-[#ebebeb] bg-white p-6 ${className ?? ''}`}
      data-testid="profile-league-card"
    >
      <div className="flex items-center gap-4">
        <LeagueEmblem tier={rank.tier} division={rank.division} size="profile" />
        <div className="min-w-0">
          <h2 className="font-sans text-[22px] font-semibold leading-tight text-[#161511]">
            {tierName}
            {divisionLabel && <span className="ml-2 tabular-nums text-[#6b7280]">{divisionLabel}</span>}
          </h2>
          <p className="mt-1 text-[13px] tabular-nums text-[#6b7280]">
            {t('retention.member_since', { year: tenureYear })}
          </p>
        </div>
      </div>

      <div className="mt-6">
        <p className="font-sans text-[15px] font-semibold text-[#161511]">
          {t('retention.gate_title')}
        </p>
        <div className="mt-3 flex flex-col gap-3.5">
          <GateMeter label={t('retention.gate.engagement')} value={gate.engagement} core={core} glow={glow} />
          <GateMeter label={t('retention.gate.tenure')} value={gate.tenure} core={core} glow={glow} />
          <GateMeter label={t('retention.gate.active_weeks')} value={gate.activeWeeks} core={core} glow={glow} />
        </div>
      </div>
    </section>
  );
}
