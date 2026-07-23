import { cn } from '@ui/lib/utils';

/**
 * Lumen brand logo — a light-aperture mark + the "Lumen" wordmark.
 *
 * The mark reads as a source of light: an amber core inside a ring, with four
 * short rays radiating out. The wordmark uses Open Sans (design-handoff-v2:
 * no serif display face) and `currentColor`, so it adapts to the light/dark
 * theme. Replaces the old Hive logo in the top-left.
 */
export function LumenLogo({ className }: { className?: string }) {
  return (
    <span className={cn('flex items-center gap-2 text-foreground', className)}>
      <svg viewBox="0 0 32 32" className="h-7 w-7 shrink-0" aria-hidden="true" fill="none">
        <circle cx="16" cy="16" r="11" stroke="currentColor" strokeWidth="2" />
        <circle cx="16" cy="16" r="5" fill="#f5a623" />
        <path
          d="M16 1.5v3M16 27.5v3M1.5 16h3M27.5 16h3"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
      <span className="font-sans text-xl font-semibold tracking-tight">Lumen</span>
    </span>
  );
}
