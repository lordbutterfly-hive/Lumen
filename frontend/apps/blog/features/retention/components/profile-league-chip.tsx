'use client';

import { LeagueEmblem } from '../emblems/league-emblem';
import { TIERS } from '../lib/tiers';
import { useProfileRetention } from '../hooks/use-viewer-retention';
import { useRankNaming } from './rank-scale';

/**
 * The small rank chip beside a profile's display name.
 *
 * ★ LIVES HERE, NOT IN profile-identity.tsx (owner ruling, 2026-08-08). It used
 * to be a private `LeagueChip` inside that file, rendering `Beacon IV` — the
 * exact string the owner could not decode ("i see beacon 4. no idea what that
 * is"). Owning it in the retention feature means the "never show a rank without
 * its scale" rule is enforced in ONE place instead of re-argued on every surface
 * that happens to want a rank on it.
 *
 * Renders `Beacon · rank 7 of 9`. No division numeral — divisions no longer
 * exist in the model. Nothing here marks a demotion: a lower rung renders with
 * exactly the same neutral treatment as a higher one.
 */

export interface ProfileLeagueChipProps {
  username: string;
  /** False for a Lumen lite account: it has no chain tenure to look up. */
  chainAccount?: boolean;
  className?: string;
}

export function ProfileLeagueChip({ username, chainAccount = true, className }: ProfileLeagueChipProps) {
  // A lite profile's rank exists, but only its OWNER may read it — the lite
  // route is session-scoped by construction. See useProfileRetention.
  const { data: summary } = useProfileRetention(username, chainAccount);
  if (!summary) return null;
  return <ChipBody tier={summary.rank.tier} className={className} />;
}

function ChipBody({ tier, className }: { tier: keyof typeof TIERS; className?: string }) {
  const { name, scale } = useRankNaming(tier);

  return (
    <span
      title={`${name} · ${scale}`}
      className={`inline-flex items-center gap-2 rounded-[13px] border border-[#ebebeb] bg-[#faf9f6] py-1 pl-1.5 pr-3 ${
        className ?? ''
      }`}
      data-testid="profile-league-chip"
    >
      <LeagueEmblem tier={tier} size="nav" />
      <span className="font-sans text-[14px] font-bold text-[#161511]">
        {name}
        <span aria-hidden="true" className="mx-1 font-medium text-[#cbd0d6]">
          ·
        </span>
        {/* THE SCALE IS NOT OPTIONAL. A rank without it is just a word. */}
        <span className="font-medium tabular-nums text-[#6b7280]" data-testid="profile-league-chip-scale">
          {scale}
        </span>
      </span>
    </span>
  );
}
