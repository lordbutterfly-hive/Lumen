/**
 * The Meritum mark — the owner's laurel wreath (asset handed over 2026-09-06),
 * which replaces the "speed-line ascent" rocket this file used to hold.
 *
 * ★★★ IT IS A REAL TRACED PATH, NOT THE BITMAP. The asset arrived as a 279x412
 * PNG: fully opaque, white paper, one flat dark-purple ink. Shipping that bitmap
 * — as an <img>, or as a CSS `mask-image` — was the thing to avoid, because
 * Lumen is dark by default AND has a light theme, and a fixed dark-purple
 * bitmap is invisible on the dark ground. `fill="currentColor"` on a real path
 * is what makes this behave like every other icon here: it takes the colour of
 * whatever it sits in, in both themes, with no per-theme asset.
 *
 * ★ INLINED, for the same reason the rocket was (its doc, 2026-08-13, still
 * applies word for word): the launch CTA in `header-token-pill.tsx` flips from
 * `ink-brand-6` to white on hover, and only an inline `currentColor` path
 * follows that. A linked <img> cannot, and a `mask-image: url(...)` would paint
 * a solid `currentColor` RECTANGLE for as long as the mask file is still in
 * flight — a coloured block flashing in the nav on every cold load. Inlining
 * also costs no extra request.
 *
 * HOW THE PATH WAS MADE (reproducible): the PNG was upsampled 4x, thresholded
 * at luminance 156 into 11 closed contours (one fused piece carrying both stems
 * and the two bottom leaves, plus 10 free leaves), and each contour was fitted
 * with an adaptive least-squares cubic Bezier fit (Schneider) at corner-split
 * tolerance 3.0, which keeps the leaf tips sharp instead of rounding them off.
 * Measured fidelity against the traced outline: IoU 0.9746, i.e. a mean
 * boundary deviation of ~0.06px at the 22px the nav renders it at.
 *
 * ★ THE 0.88 BOX SCALE IS A MEASUREMENT, NOT A GUESS. Dropped into the 24-unit
 * grid at full height the wreath is 21.07 x 24.00 units and its ink area comes
 * out at 0.998x the rocket's — identical mass, but it would then bleed to the
 * very edge of the box and stand taller than every lucide neighbour in the rail
 * (those live at ~20/24). Scaled to 0.88 the ink box is 18.54 x 21.12, and
 * 21.12 is the rocket's own live height (21.1) to two decimals. So this sits on
 * exactly the optical line the icon it replaces sat on. Ink lands at 0.78x the
 * rocket's, which is the right side of equal: a SOLID mark reads heavier than a
 * 1.9-stroke outline at equal area.
 *
 * ★ NO 20px FLOOR any more. The rocket carried one ("never render under 20px")
 * because its three speed lines fused into a smudge below it. A wreath has no
 * such feature; checked at 1x device scale it still reads at 16px. 18px and up
 * is comfortable, and every call site here is 20 or 22.
 *
 * `aria-hidden` and `focusable="false"`: every call site pairs it with real text
 * ("Launch your Meritum", "Meritum tokens", "@handle"), so announcing it again
 * would just make a screen reader say the same thing twice.
 */

// 11 closed subpaths in one `d`; see the trace note above. Kept on one line on
// purpose — it is generated data, and re-wrapping it would only invite hand-edits.
const LAUREL_D =
  'M3.82 16.63c-0.03 0.14 0.12 0.26 0.2 0.38c0.17 0.29 0.36 0.57 0.58 0.81c0.69 0.77 1.57 1.46 2.56 1.75c0.5 0.15 1.04 0.17 1.56 0.12c0.22-0.02 0.43-0.09 0.65-0.07c0.34 0.03 0.63 0.3 0.93 0.45c0.28 0.14 0.56 0.27 0.81 0.45c0.1 0.07 0.28 0.11 0.3 0.23c-0.04 0.2-0.3 0.26-0.47 0.38c-0.41 0.29-0.83 0.56-1.25 0.85c-0.18 0.13-0.47 0.42-0.33 0.59c0.23 0.27 0.71-0.16 1-0.36c0.4-0.28 0.78-0.56 1.2-0.81c0.17-0.1 0.33-0.27 0.53-0.31c0.2 0 0.35 0.19 0.53 0.28c0.46 0.23 0.87 0.57 1.29 0.86c0.27 0.19 0.73 0.59 0.95 0.34c0.18-0.2-0.2-0.53-0.42-0.68c-0.36-0.25-0.72-0.49-1.08-0.74c-0.19-0.13-0.51-0.17-0.56-0.39c0.02-0.11 0.17-0.14 0.27-0.2c0.23-0.14 0.48-0.26 0.72-0.4c0.34-0.2 0.66-0.51 1.05-0.55c0.25-0.02 0.5 0.05 0.74 0.07c0.38 0.04 0.77-0.03 1.15-0.07c0.98-0.1 1.86-0.8 2.52-1.53c0.28-0.31 0.52-0.64 0.75-0.98c0.1-0.14 0.27-0.29 0.24-0.46c-0.18-0.24-0.6-0.05-0.9-0.05c-0.64 0-1.3 0.14-1.89 0.38c-1.47 0.59-2.49 1.98-3.91 2.69c-0.34 0.17-0.67 0.36-1.01 0.53c-0.15 0.07-0.29 0.2-0.46 0.19c-0.45-0.05-0.81-0.41-1.22-0.62c-0.56-0.28-1.12-0.58-1.63-0.93c-0.84-0.59-1.56-1.41-2.52-1.8c-0.63-0.25-1.31-0.44-1.99-0.44c-0.21 0-0.42 0-0.62 0c-0.1 0-0.24-0.03-0.3 0.05zM16.03 13.95c-0.92 0.55-1.22 1.79-1.53 2.81c-0.12 0.38-0.08 0.8-0.08 1.2c0 0.2-0.09 0.49 0.07 0.61c0.12 0.05 0.24-0.11 0.34-0.19c0.23-0.18 0.46-0.36 0.67-0.57c0.68-0.68 1.08-1.75 0.98-2.71c-0.03-0.29-0.09-0.58-0.22-0.84c-0.06-0.11-0.07-0.28-0.19-0.33c-0.02 0-0.03 0-0.05 0.01zM8.05 13.95c-0.2 0.15-0.21 0.45-0.28 0.68c-0.31 1.03 0.07 2.36 0.83 3.12c0.21 0.21 0.44 0.39 0.67 0.57c0.11 0.09 0.22 0.25 0.35 0.22c0.12-0.06 0.06-0.25 0.08-0.38c0.04-0.41 0.02-0.82-0.02-1.22c-0.08-0.83-0.49-1.62-0.96-2.3c-0.18-0.25-0.31-0.63-0.62-0.7c-0.01 0-0.03 0.01-0.04 0.01zM2.73 11.22c-0.09 0.13 0.03 0.31 0.04 0.46c0.04 0.35 0.17 0.69 0.27 1.03c0.34 1.14 1.14 2.35 2.24 2.79c0.3 0.12 0.6 0.25 0.91 0.35c0.12 0.03 0.24 0.14 0.35 0.09c0.13-0.13-0.04-0.36-0.06-0.54c-0.04-0.43-0.16-0.86-0.35-1.25c-0.49-0.98-1.25-1.93-2.23-2.43c-0.26-0.13-0.53-0.25-0.79-0.38c-0.11-0.06-0.23-0.16-0.36-0.13zM21.2 11.19c-1.33 0.53-2.69 1.51-3.22 2.84c-0.18 0.44-0.35 0.89-0.4 1.37c-0.02 0.18-0.17 0.41-0.04 0.54c0.14 0.07 0.31-0.07 0.45-0.13c0.32-0.13 0.63-0.26 0.93-0.41c0.96-0.48 1.72-1.48 2.03-2.51c0.13-0.43 0.3-0.87 0.3-1.32c0-0.12 0.11-0.28 0.02-0.37c-0.02-0.01-0.05-0.01-0.07 0zM16.41 7.94c-0.21 0.21-0.14 0.59-0.17 0.89c-0.07 0.72-0.13 1.48 0.08 2.18c0.2 0.66 0.37 1.35 0.68 1.97c0.11 0.22 0.1 0.55 0.32 0.68c0.1 0.02 0.15-0.16 0.2-0.25c0.25-0.41 0.33-0.91 0.46-1.37c0.34-1.14-0.04-2.59-0.83-3.48c-0.21-0.23-0.39-0.57-0.7-0.63c-0.01 0-0.03 0-0.04 0zM7.71 7.94c-1.2 0.72-1.74 2.48-1.61 3.87c0.05 0.48 0.22 0.94 0.4 1.39c0.07 0.17 0.11 0.46 0.3 0.46c0.06-0.02 0.06-0.12 0.09-0.18c0.07-0.14 0.15-0.28 0.21-0.43c0.19-0.48 0.41-0.95 0.56-1.44c0.23-0.76 0.3-1.58 0.3-2.37c0-0.3-0.04-0.61-0.07-0.91c-0.01-0.13 0.01-0.31-0.1-0.39c-0.02-0.01-0.05-0.01-0.07 0zM4.12 5.35c-0.29 0.29-0.25 0.78-0.33 1.18c-0.2 1-0.17 2.13 0.29 3.04c0.19 0.37 0.45 0.7 0.71 1.03c0.12 0.15 0.28 0.4 0.46 0.35c0.11-0.05 0.09-0.22 0.13-0.33c0.12-0.29 0.2-0.6 0.23-0.91c0.04-0.35 0.13-0.7 0.1-1.05c-0.07-0.65-0.26-1.31-0.55-1.89c-0.19-0.38-0.43-0.73-0.69-1.05c-0.11-0.13-0.17-0.38-0.34-0.38zM19.98 5.32c-0.31 0.19-0.45 0.57-0.66 0.87c-0.61 0.87-0.96 2.01-0.85 3.07c0.04 0.43 0.1 0.86 0.22 1.27c0.05 0.17 0.03 0.42 0.19 0.48c0.17 0 0.27-0.2 0.38-0.32c0.24-0.24 0.47-0.48 0.64-0.77c0.51-0.85 0.65-1.94 0.56-2.92c-0.04-0.4-0.15-0.79-0.27-1.17c-0.05-0.18-0.01-0.47-0.19-0.52zM8.52 1.51c-1.4 0.56-2.59 2.3-2.44 3.8c0.05 0.46 0.13 0.92 0.3 1.34c0.06 0.15 0.05 0.38 0.2 0.45c0.22 0 0.3-0.32 0.46-0.47c0.37-0.37 0.75-0.77 0.99-1.25c0.41-0.81 0.67-1.73 0.67-2.64c0-0.26 0-0.53-0.02-0.79c-0.01-0.15 0.05-0.34-0.06-0.44c-0.03-0.01-0.06-0.01-0.09 0zM15.74 1.44c-0.16 0.12-0.06 0.39-0.08 0.58c-0.05 0.5-0.05 1.01 0 1.51c0.09 0.93 0.55 1.82 1.08 2.59c0.16 0.23 0.36 0.42 0.55 0.62c0.12 0.13 0.19 0.34 0.36 0.37c0.13-0.03 0.11-0.25 0.17-0.37c0.18-0.36 0.29-0.77 0.33-1.17c0.06-0.58 0.03-1.19-0.13-1.75c-0.17-0.57-0.62-1.04-1.04-1.46c-0.25-0.25-0.53-0.47-0.81-0.67c-0.13-0.09-0.25-0.26-0.41-0.26z';

export function CreatorTokenLaurel({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path d={LAUREL_D} />
    </svg>
  );
}

export default CreatorTokenLaurel;
