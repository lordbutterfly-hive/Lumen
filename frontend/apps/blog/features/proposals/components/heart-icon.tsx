/**
 * Vote-value heart glyph from the design handoff (Proposals.dc.html) — filled
 * brand-red when the viewer supports the proposal, outline muted otherwise.
 * Not in the shared Lucide-style icon set (packages/ui/components/icons.tsx),
 * so it's a small local inline SVG per the handoff's exact path data.
 */
export default function HeartIcon({ filled, className }: { filled: boolean; className?: string }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill={filled ? '#c0392b' : 'none'}
      stroke={filled ? '#c0392b' : '#9ca3af'}
      strokeWidth="1.9"
      className={className}
      aria-hidden="true"
    >
      <path d="M20.8 4.6a5.5 5.5 0 00-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 10-7.8 7.8l1.1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 000-7.8z" />
    </svg>
  );
}
