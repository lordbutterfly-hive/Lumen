'use client';

import { useEffect, useState } from 'react';
import { watchArm } from '@/blog/lib/inquisition/arm';

/**
 * Whether Inquisition mode is on, kept live: the same flag and the same signal the
 * theme follows (`watchArm`), so anything using this switches at the exact moment the
 * page does. Choosing light mode disarms Inquisition (`theme-toggle.tsx`), so it goes
 * false then too. `false` on the server and until mount, since the flag lives in
 * localStorage.
 */
export function useInquisitionArmed(): boolean {
  const [armed, setArmed] = useState(false);
  useEffect(() => watchArm(setArmed), []);
  return armed;
}

/**
 * ★ THE INQUISITION SEAL (2026-09-23, owner: "only stays on profile pic if inquisition mode
 * is on. if turned off it disappears. its an indicator ... the lens should be the
 * indicator"). A flat brass seal on the lower right of the 36px header avatar, the only
 * header signal that the mode is on. Spec: LUMEN-DOCS handoff "Inquisition seal, header
 * indicator (option 3e)": 22px seal, offsets -9/-7px, brass #c89b4a, a 3px cut-out ring in
 * the header's own background (`--surface-1`, so it matches in any theme), 14px lens glyph
 * with the lens up-right and the handle down-left. No glow, gradient or animation.
 *
 * The caller renders it only while armed, so an unarmed avatar is exactly as before. It
 * sits inside the avatar's button, so a click on it opens the account menu like the rest
 * of the avatar; screen readers get the state from the button's own label, which the
 * header extends while armed. `title` gives the native tooltip.
 */
export function InquisitionSeal({ label }: { label: string }) {
  return (
    <span
      className="absolute -bottom-[7px] -right-[9px] z-[31] inline-flex h-[22px] w-[22px] items-center justify-center rounded-full bg-[#c89b4a] shadow-[0_0_0_3px_rgb(var(--surface-1))]"
      title={label}
      aria-hidden="true"
      data-testid="inquisition-seal"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#17130c" strokeLinecap="round">
        <circle cx="14" cy="10" r="6.2" strokeWidth="2.8" />
        <path d="M9.4 14.6 3.6 20.4" strokeWidth="3.6" />
      </svg>
    </span>
  );
}
