'use client';

import { useId } from 'react';
import { LeagueBand, LeagueTier, type Division } from '../types';
import { TIERS } from '../lib/tiers';

// The single, size-responsive Lightkeeper emblem. ONE inline SVG per tier, keyed
// off TIERS[tier] — frame encodes the band (open hearth cup → hex → ring+rays),
// the inner glyph is the light source (a flame), and the colors come ONLY from
// the tier's { core, frame, glow } tokens (never a second color source). A soft
// static radial glow sits behind every emblem; the Celestial apex additionally
// gets a slow rotate/breathe, but ONLY at the large profile size and ONLY when
// the viewer has not asked to reduce motion. The emblem is a shape (a framed
// glyph), NEVER a bare colored dot — dots are the market/community grammar.

export type EmblemSize = 'nav' | 'byline' | 'popover' | 'profile';

const SIZE_PX: Record<EmblemSize, number> = {
  nav: 20,
  byline: 16,
  popover: 56,
  profile: 120
};

export interface LeagueEmblemProps {
  tier: LeagueTier;
  // Accepted for API symmetry; the division roman numeral is rendered as serif
  // text by the popover/profile consumers (never painted onto the emblem itself).
  division?: Division;
  size: EmblemSize;
  className?: string;
}

const RAY_COUNT = 12;
const RAYS = Array.from({ length: RAY_COUNT }, (_, i) => {
  const a = (i / RAY_COUNT) * Math.PI * 2 - Math.PI / 2;
  return {
    key: i,
    x1: 50 + 40 * Math.cos(a),
    y1: 50 + 40 * Math.sin(a),
    x2: 50 + 47 * Math.cos(a),
    y2: 50 + 47 * Math.sin(a)
  };
});

// I..IV, where I is the strongest division inside a tier.
const ROMAN: Record<Division, string> = { 1: 'I', 2: 'II', 3: 'III', 4: 'IV' };
export function divisionToRoman(division: Division): string {
  return ROMAN[division];
}

export function LeagueEmblem({ tier, size, className }: LeagueEmblemProps) {
  const info = TIERS[tier];
  const { core, frame, glow } = info.color;
  const px = SIZE_PX[size];
  const rawId = useId();
  const uid = rawId.replace(/[^a-zA-Z0-9]/g, '');
  const gradId = `lk-glow-${uid}`;
  const shouldAnimate = info.animated && size === 'profile';

  return (
    <span
      className={className}
      style={{ display: 'inline-flex', width: px, height: px, lineHeight: 0 }}
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 100 100"
        width={px}
        height={px}
        role="img"
        style={{ overflow: 'visible' }}
      >
        <defs>
          <radialGradient id={gradId} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor={glow} stopOpacity={0.55} />
            <stop offset="60%" stopColor={glow} stopOpacity={0.22} />
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

        {/* Static soft radial glow (always present) */}
        <circle
          cx="50"
          cy="50"
          r="48"
          fill={`url(#${gradId})`}
          className={shouldAnimate ? `lk-glow-${uid}` : undefined}
        />

        <FrameForBand
          band={info.band}
          frame={frame}
          raysClassName={shouldAnimate ? `lk-rays-${uid}` : undefined}
        />

        {/* Inner glyph = the light source (a flame), tinted by the tier core. */}
        <path
          d="M50 26 C 60 42, 63 54, 50 68 C 37 54, 40 42, 50 26 Z"
          fill={core}
          stroke={frame}
          strokeWidth={1.5}
          strokeLinejoin="round"
        />
        <path
          d="M50 40 C 55 48, 56 56, 50 64 C 44 56, 45 48, 50 40 Z"
          fill={glow}
          opacity={0.9}
        />
      </svg>
    </span>
  );
}

function FrameForBand({
  band,
  frame,
  raysClassName
}: {
  band: LeagueBand;
  frame: string;
  raysClassName?: string;
}) {
  if (band === LeagueBand.Kindling) {
    // Open hearth / cup arc cradling the flame.
    return (
      <path
        d="M20 56 Q 20 80 50 82 Q 80 80 80 56"
        fill="none"
        stroke={frame}
        strokeWidth={5}
        strokeLinecap="round"
      />
    );
  }

  if (band === LeagueBand.MadeLight) {
    // Engineered light — a hex frame.
    return (
      <path
        d="M50 8 L86 29 L86 71 L50 92 L14 71 L14 29 Z"
        fill="none"
        stroke={frame}
        strokeWidth={4.5}
        strokeLinejoin="round"
      />
    );
  }

  // Celestial — ring + rays (the animated group at profile size).
  return (
    <g className={raysClassName}>
      <circle cx="50" cy="50" r="38" fill="none" stroke={frame} strokeWidth={4} />
      {RAYS.map((r) => (
        <line
          key={r.key}
          x1={r.x1}
          y1={r.y1}
          x2={r.x2}
          y2={r.y2}
          stroke={frame}
          strokeWidth={3}
          strokeLinecap="round"
        />
      ))}
    </g>
  );
}
