/**
 * The Creator Tokens mark — "variation 8, speed-line ascent" (design handoff,
 * 2026-08-13).
 *
 * Inlined rather than shipped as a file in `public/`: it is `stroke="currentColor"`,
 * so inlining is what lets it inherit the pill's colour through its hover state
 * (the launch CTA flips from `ink-brand-6` to white on hover — a linked `<img>`
 * could not follow that), and it costs no extra request.
 *
 * ★★★ NEVER RENDER THIS UNDER 20px. The handoff's README is explicit: below 20px
 * the three speed lines fuse into a smudge, and the stroke must not be scaled
 * below 1.9 at a 24px grid. `size` defaults to 20 — the floor, not a suggestion.
 * That is also why this did NOT replace every `◈` in the feature: the byline chip
 * (`token-author-chip.tsx`) renders its glyph at 13px, where this icon is not
 * legible, so that surface deliberately keeps the glyph.
 *
 * `aria-hidden` and `focusable="false"`: every call site pairs it with real text
 * ("Launch your token", "@handle"), so announcing it again would just make a
 * screen reader say the same thing twice.
 */
export function CreatorTokenRocket({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path d="M12 2.4c2.3 2.2 3.4 5 3.4 8v3.7H8.6v-3.7c0-3 1.1-5.8 3.4-8z" />
      <circle cx="12" cy="8.6" r="1.5" />
      <path d="M8.6 12.4L6.2 14.8v2.6l2.4-1.4M15.4 12.4l2.4 2.4v2.6l-2.4-1.4" />
      <path d="M12 18.2v3.4M8.4 18.8v2.1M15.6 18.8v2.1" />
    </svg>
  );
}

export default CreatorTokenRocket;
