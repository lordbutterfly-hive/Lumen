'use client';

interface ManabarRingProps {
  percentage: number;
  color: string;
  size: number;
  thickness: number;
  className?: string;
}

/**
 * A circular progress RING: a `thickness`-wide band around a genuinely transparent
 * middle, so whatever it is drawn around stays visible.
 *
 * ★★★ IT USED TO BE A FILLED PIE, AND THAT IS WHY THE ICONS INSIDE IT WERE BURIED
 * (owner, 2026-08-18: "the way the icons are filling up should be an outer ring not
 * inner fill that hides the icon").
 *
 * The old version painted the conic gradient across the WHOLE disc and then covered
 * the middle with a smaller circle carrying `backgroundColor: 'var(--background)'`.
 * That declaration never applied. `--background` is a raw HSL TRIPLET
 * (`0 0% 100%` — packages/tailwindcss/globals.css:7), not a colour: every other
 * consumer wraps it, and this file's own border did too (`hsl(var(--border))`). A
 * bare `var(--background)` resolves to `background-color: 0 0% 100%`, which is an
 * invalid value, so the declaration was dropped and the "hole" was fully
 * transparent. What the reader saw was the conic wedge filling the entire circle
 * behind the glyph.
 *
 * Three surfaces were affected, all of them the "icon inside a ring" shape this
 * component exists for: the left rail's rank emblem, the daily card, and the header
 * avatar (which stacks THREE of these over the profile picture on hover).
 *
 * ★ THE HOLE IS PUNCHED WITH A MASK, NOT FILLED WITH A COLOUR. Filling it — even
 * with the correctly-wrapped `hsl(var(--background))` — would only be right on top
 * of one surface. The rail rows tint warm on hover, the popover sits on
 * `surface-1`, and the header ring sits on an avatar; an opaque disc would show as a
 * pale circle over every one of them. A mask leaves the middle actually see-through,
 * so the emblem, the avatar and the count read at full contrast on any background.
 *
 * The unfilled arc is drawn in `hsl(var(--border))` rather than left blank: a ring
 * that vanishes where progress stops reads as a broken crescent, and the track is
 * what makes the filled part legible as a proportion.
 */
export function ManabarRing({ percentage, color, size, thickness, className = '' }: ManabarRingProps) {
  // Clamped rather than trusted: `percentage` arrives from chain-derived maths that
  // legitimately produces >100 (a manabar mid-regeneration) and from a progress
  // figure that can be 0. Either extreme drew a wedge past a full turn before.
  const pct = Math.max(0, Math.min(100, Number.isFinite(percentage) ? percentage : 0));
  const angle = (pct / 100) * 360;
  // `closest-side` on a square box makes the gradient ray exactly the radius, so
  // `calc(100% - Npx)` is "N pixels in from the edge" — the band width, in the same
  // unit every caller already passes.
  const ring = `radial-gradient(closest-side, transparent calc(100% - ${thickness}px), #000 calc(100% - ${thickness}px))`;

  return (
    <div
      className={className}
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: `conic-gradient(from 0deg, ${color} 0deg, ${color} ${angle}deg, hsl(var(--border)) ${angle}deg, hsl(var(--border)) 360deg)`,
        // Both spellings: the unprefixed property is not yet universal in Safari, and
        // a browser that honours neither falls back to the old filled-disc look
        // rather than to a blank element.
        WebkitMaskImage: ring,
        maskImage: ring
      }}
    />
  );
}
