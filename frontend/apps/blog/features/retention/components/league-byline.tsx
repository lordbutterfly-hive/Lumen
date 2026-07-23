'use client';

import { LeagueEmblem } from '../emblems/league-emblem';
import { TIERS } from '../lib/tiers';
import type { Division, LeagueTier } from '../types';

// The byline emblem. Appears ONLY from Torch up (TIERS[tier].showBylineEmblem),
// so a byline emblem always means "proven regular". It is a static framed glyph
// at the small byline size — never animated, and it NEVER tints the author
// handle. Not mounted here; the post card wires it in separately.

export interface LeagueBylineProps {
  tier: LeagueTier;
  division?: Division;
  className?: string;
}

export function LeagueByline({ tier, division, className }: LeagueBylineProps) {
  if (!TIERS[tier].showBylineEmblem) return null;
  return <LeagueEmblem tier={tier} division={division} size="byline" className={className} />;
}
