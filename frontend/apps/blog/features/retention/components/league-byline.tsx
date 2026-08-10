'use client';

import { useTranslation } from '@/blog/i18n/client';
import { LeagueEmblem } from '../emblems/league-emblem';
import { TIERS } from '../lib/tiers';
import { tierScale } from './rank-scale';
import type { LeagueTier } from '../types';

// The byline emblem. Appears ONLY from the light band up
// (TIERS[tier].showBylineEmblem, i.e. Ember and above), so a byline emblem
// always means "out of the dark". It is a static framed glyph at the small
// byline size — never animated, and it NEVER tints the author handle.
//
// ★★ MOUNTED SINCE 2026-08-09 in features/discovery-feed/medium-post-card.tsx, fed by
// `useRankMarks` → /api/streak/marks → the `lumen_hive_rank` snapshot. The history below
// is kept because it is the reason the mount had to wait for a batch endpoint.
//
// ★ WAS MOUNTED NOWHERE, ON PURPOSE (owner ruling, 2026-08-08).
// features/discovery-feed/medium-post-card.tsx used to feed this from
// `bylineTierFromReputation(post.author_reputation)`, which was NOT the function
// behind the profile's rank — so one person carried two contradicting ranks in one
// session (@taskmaster4450: Beacon in the feed, Torch on the profile; @hivebuzz:
// Beacon in the feed, Candle on the profile). It was removed at the call site rather
// than here, because the component is fine; its INPUT was the bug.
//
// ★ AND THE CHEAP INPUT NO LONGER EXISTS AT ALL (2026-08-09).
// `bylineTierFromReputation` is deleted along with the rest of the reputation proxy,
// so there is not even a tempting shortcut left. The rank is now a count of credited
// givers, which cannot be derived from a post payload at any price.
//
// IF YOU RE-MOUNT THIS: the rung must come from the same source the profile uses
// (/api/streak/[user] via useRetention). A feed of N authors means N of those lookups,
// so the honest fix is a BATCH endpoint — never a second, cheaper, disagreeing rank
// function. The persisted store (migration 0028) makes a batch endpoint cheap for the
// first time, since a warm account no longer needs a feed walk at all.

// ★★ AND IT IS LABELLED NOW (2026-08-09). A tester spotted five marks across thirty feed
// cards, could not tell two different rungs apart, guessed "verification tick", then
// "paid badge", and said it read as marking some people as Somehow Special. An unlabelled
// glyph that carries no readable distinction is worse than no glyph: it implies a status
// system the reader cannot inspect. So the emblem gets the size and stroke work in
// league-emblem.tsx and a hoverable label here: the rung and its position, which is the
// question actually being asked. The mechanism stays one click away on /ranks — a longer
// tooltip was drafted and cut for the copy budget.
//
// The emblem span is `aria-hidden`, so this wrapper is the only accessible name. `title`
// is deliberate over a positioned tooltip primitive: thirty of these on a feed page, and
// a native title costs nothing per card.

export interface LeagueBylineProps {
  tier: LeagueTier;
  /** 1-based rung, from the same snapshot the emblem came from. */
  rankNumber: number;
  className?: string;
}

export function LeagueByline({ tier, rankNumber, className }: LeagueBylineProps) {
  const { t } = useTranslation('common_blog');
  if (!TIERS[tier].showBylineEmblem) return null;
  // The scale comes off the ladder, never from the snapshot's own number, so a stale
  // stored `rankNumber` can be off by a rung but can never claim "rank 8 of 7".
  const { position, total } = tierScale(tier);
  const label = t('retention.byline_title', {
    tier: t(TIERS[tier].labelKey),
    scale: t('retention.scale', { position: rankNumber > 0 ? rankNumber : position, total })
  });
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-testid="league-byline"
      data-tier={tier}
      style={{ display: 'inline-flex', lineHeight: 0 }}
      className={className}
    >
      <LeagueEmblem tier={tier} size="byline" />
    </span>
  );
}
