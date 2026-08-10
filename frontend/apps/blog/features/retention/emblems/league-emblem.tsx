'use client';

import { useId } from 'react';
import { LeagueBand, LeagueTier } from '../types';
import { TIERS } from '../lib/tiers';

/**
 * The single, size-responsive ladder emblem. ONE inline SVG per rung, keyed off
 * TIERS[tier] — the FRAME comes from the band, so the emblem tells you how far
 * your light carries before you read a single word:
 *
 *   KINDLING  (rungs 1-4, Spark … Lantern) — a filled flame in an open cup, with
 *             a small close glow. A real light, held. No ring, because nothing is
 *             steering by it yet, and no byline mark.
 *   SIGNAL    (rungs 5-7, Torch … Halo)    — a closed ring and a full glow. The
 *             ring IS the claim "other people navigate by this", which is exactly
 *             the claim the byline mark makes, which is why the ring and the mark
 *             start on the same rung.
 *   CELESTIAL (rungs 8-9, Aurora, Lumen)   — ring plus rays, and a slow
 *             breathe/rotate at profile size only.
 *
 * ★ NO RUNG IS DRAWN AS AN ABSENCE ANY MORE (2026-08-09). The previous version gave
 * rungs 1-3 a BROKEN ring around a HOLLOW flame and argued in this file that "this
 * is not a dimmer setting, it is an absence". That was the visual half of the same
 * mistake the names made: it drew a new account as nothing, when a new account
 * having no audience is our distribution failing, not their light being out. Every
 * flame is filled now. What grows up the ladder is reach.
 *
 * Colors come ONLY from the rung's { core, frame, glow } tokens (never a second
 * color source). The emblem is a shape (a framed glyph), NEVER a bare colored dot —
 * dots are the market/community grammar.
 *
 * NOTE: divisions no longer exist in the model, so there is no numeral here and no
 * `division` prop. That numeral ("Beacon 4") was the owner's original complaint and
 * it is gone from the data, not just hidden.
 */

export type EmblemSize = 'nav' | 'byline' | 'popover' | 'profile';

const SIZE_PX: Record<EmblemSize, number> = {
  nav: 22,
  // ★ 16 → 18, AND THE STROKES SCALE (2026-08-09). A tester saw five marks in a
  // thirty-card feed, could not tell two DIFFERENT rungs apart, and guessed the glyph was
  // a verification tick. The cause is not the colour: the band is carried by the FRAME —
  // an open cup, a closed ring, a ring with rays — and at 16px a 4-unit ring stroke on a
  // 100-unit viewBox paints at 0.64 device pixels while the rays paint at 0.48. The frame
  // was structurally there and optically absent, so every rung collapsed to the same
  // coloured blob. See SMALL_PX below.
  byline: 18,
  popover: 56,
  profile: 120
};

/**
 * At or below this rendered size the frame is redrawn heavier and simpler.
 *
 * Not a "make it bolder" tweak — it is the difference between the three bands being
 * distinguishable and not. Twelve rays at 3 units read as a fuzzy halo at 18px, so the
 * small variant uses eight longer, thicker ones: fewer marks, each actually visible.
 */
const SMALL_PX = 24;

export interface LeagueEmblemProps {
  tier: LeagueTier;
  size: EmblemSize;
  className?: string;
}

function buildRays(count: number, inner: number, outer: number) {
  return Array.from({ length: count }, (_, i) => {
    const a = (i / count) * Math.PI * 2 - Math.PI / 2;
    return {
      key: i,
      x1: 50 + inner * Math.cos(a),
      y1: 50 + inner * Math.sin(a),
      x2: 50 + outer * Math.cos(a),
      y2: 50 + outer * Math.sin(a)
    };
  });
}

/** Twelve fine rays at profile size; eight long thick ones where 12 would blur. */
const RAYS = buildRays(12, 40, 47);
const RAYS_SMALL = buildRays(8, 42, 56);

/** The flame silhouette, shared by every rung — only its FRAME changes. */
const FLAME_OUTER = 'M50 26 C 60 42, 63 54, 50 68 C 37 54, 40 42, 50 26 Z';
const FLAME_INNER = 'M50 40 C 55 48, 56 56, 50 64 C 44 56, 45 48, 50 40 Z';

export function LeagueEmblem({ tier, size, className }: LeagueEmblemProps) {
  // `useId` runs BEFORE the rank-0 guard below, deliberately: a hook after an early return is a
  // conditional hook call, and React would break the moment an unranked emblem rendered beside a
  // ranked one in the same list — which is the normal case in a feed.
  const rawId = useId();

  // ★ RANK 0 DRAWS NOTHING, AT ANY SIZE (2026-08-09). Every rung above it is "a light that
  // exists", and an account with no measured activity has nothing alight yet — a filled flame
  // for rank 0 would be the same overstatement as a 100% bar off one vote. Not an absence-glyph
  // either (the broken-ring era of this file is documented above and was correctly deleted):
  // simply nothing, until one post or comment makes it rank 1.
  if (tier === LeagueTier.Unranked) return null;

  const info = TIERS[tier];
  const { core, frame, glow } = info.color;
  const px = SIZE_PX[size];
  const uid = rawId.replace(/[^a-zA-Z0-9]/g, '');
  const gradId = `lk-glow-${uid}`;
  const shouldAnimate = info.animated && size === 'profile';
  // A held light glows close to itself; a signal glows out to its ring. Same
  // gradient, different radius, so the difference reads at 20px without a second
  // colour token.
  const held = info.band === LeagueBand.Kindling;
  const glowRadius = held ? 30 : 48;
  const small = px <= SMALL_PX;

  return (
    <span
      className={className}
      style={{ display: 'inline-flex', width: px, height: px, lineHeight: 0 }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 100 100" width={px} height={px} role="img" style={{ overflow: 'visible' }}>
        <defs>
          <radialGradient id={gradId} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor={glow} stopOpacity={held ? 0.4 : 0.55} />
            <stop offset="60%" stopColor={glow} stopOpacity={held ? 0.14 : 0.22} />
            <stop offset="100%" stopColor={glow} stopOpacity={0} />
          </radialGradient>
        </defs>

        {shouldAnimate && (
          <style>{`
            .lk-glow-${uid} { transform-box: fill-box; transform-origin: center; animation: lk-breathe-${uid} 4.5s ease-in-out infinite; }
            .lk-rays-${uid} { transform-box: fill-box; transform-origin: center; animation: lk-spin-${uid} 26s linear infinite; }
            @keyframes lk-spin-${uid} { to { transform: rotate(360deg); } }
            @keyframes lk-breathe-${uid} { 0%,100% { transform: scale(1); opacity: 0.85; } 50% { transform: scale(1.06); opacity: 1; } }
            @media (prefers-reduced-motion: reduce) {
              .lk-glow-${uid}, .lk-rays-${uid} { animation: none; }
            }
          `}</style>
        )}

        <circle
          cx="50"
          cy="50"
          r={glowRadius}
          fill={`url(#${gradId})`}
          className={shouldAnimate ? `lk-glow-${uid}` : undefined}
        />

        <EmblemFrame
          band={info.band}
          frame={frame}
          small={small}
          raysClassName={shouldAnimate ? `lk-rays-${uid}` : undefined}
        />

        {/* The light source. Filled on every rung, because every rung is alight. The
            outline thickens with the frame: at 18px a 1.5-unit stroke disappears and the
            flame loses its edge against the glow. */}
        <path d={FLAME_OUTER} fill={core} stroke={frame} strokeWidth={small ? 4 : 1.5} strokeLinejoin="round" />
        <path d={FLAME_INNER} fill={glow} opacity={0.9} />
      </svg>
    </span>
  );
}

/**
 * The band's frame — and, at small sizes, a heavier redraw of it.
 *
 * ★ THE FRAME IS THE WHOLE INFORMATION CHANNEL, so it has to survive the size it is
 * actually shown at. In the feed the emblem is 18px: a stroke measured in viewBox units
 * lands at `units × 18/100` device pixels, so the original 4-unit ring painted at 0.64px
 * and the 3-unit rays at 0.48px — both below one pixel, both anti-aliased into the glow.
 * A tester consequently could not tell a Signal rung from a Celestial one and read the
 * result as a generic badge. Same shapes, heavier lines, fewer rays.
 */
function EmblemFrame({
  band,
  frame,
  small,
  raysClassName
}: {
  band: LeagueBand;
  frame: string;
  small: boolean;
  raysClassName?: string;
}) {
  if (band === LeagueBand.Kindling) {
    // An open cup cradling the flame. Held, not broadcast.
    return (
      <path
        d="M20 56 Q 20 80 50 82 Q 80 80 80 56"
        fill="none"
        stroke={frame}
        strokeWidth={small ? 9 : 5}
        strokeLinecap="round"
      />
    );
  }

  if (band === LeagueBand.Signal) {
    // A closed ring. Something other people can steer by.
    return <circle cx="50" cy="50" r="38" fill="none" stroke={frame} strokeWidth={small ? 8 : 4} />;
  }

  // Celestial — ring + rays (the animated group at the top two rungs).
  const rays = small ? RAYS_SMALL : RAYS;
  return (
    <g className={raysClassName}>
      <circle cx="50" cy="50" r="38" fill="none" stroke={frame} strokeWidth={small ? 8 : 4} />
      {rays.map((r) => (
        <line
          key={r.key}
          x1={r.x1}
          y1={r.y1}
          x2={r.x2}
          y2={r.y2}
          stroke={frame}
          strokeWidth={small ? 7 : 3}
          strokeLinecap="round"
        />
      ))}
    </g>
  );
}
