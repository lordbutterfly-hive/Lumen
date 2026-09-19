/**
 * ════ ARMING THE MODE ════
 *
 * ★★★ ARMING FORCES DARK, AND THAT IS THE JOKE (owner, 2026-09-19: "once activated
 * ... if mode light it should automatically turn the theme black. thats the point.
 * its kind of tongue and cheek"). The lights go down when the examination starts.
 *
 * ★★ DISARMING PUTS THE READER BACK WHERE THEY WERE, AND ARMING NEVER TOOK ANYTHING
 * AWAY. The mode paints dark onto the document; it does not write the reader's stored
 * preference. That way closing the tab mid-joke cannot leave somebody converted to
 * dark forever — see `arm()` for the reproduction that forced this.
 *
 * ★ SESSION-SCOPED, NOT PER ACCOUNT (spec §2.7). `sessionStorage`, so closing the tab
 * disarms. Nobody should sit in this by accident for a month, and re-arming is one
 * click.
 */

import { applyTheme, readTheme, resolveTheme, type Theme } from '@/blog/lib/theme';

export const ARM_KEY = 'inquisition';
export const ARM_EVENT = 'lumen:inquisition';

interface ArmState {
  armed: boolean;
  /** The theme the reader was in when they armed it. */
  restore: Theme | null;
}

function read(): ArmState {
  if (typeof window === 'undefined') return { armed: false, restore: null };
  try {
    const raw = window.sessionStorage.getItem(ARM_KEY);
    if (!raw) return { armed: false, restore: null };
    const parsed = JSON.parse(raw) as Partial<ArmState>;
    return {
      armed: parsed.armed === true,
      restore: parsed.restore === 'light' || parsed.restore === 'dark' ? parsed.restore : null
    };
  } catch {
    return { armed: false, restore: null };
  }
}

function write(state: ArmState): void {
  try {
    window.sessionStorage.setItem(ARM_KEY, JSON.stringify(state));
  } catch {
    // Blocked storage: the mode still applies to this page, it just will not survive
    // a reload. Failing to persist must never fail to arm.
  }
  window.dispatchEvent(new CustomEvent(ARM_EVENT));
}

export function isArmed(): boolean {
  return read().armed;
}

/**
 * ★★★ ARMING NO LONGER WRITES THE READER'S THEME PREFERENCE (found by adversarial
 * review, 2026-09-19, and it is exactly the harm the note at the top of this file says
 * a joke has no right to do).
 *
 * The armed flag lives in sessionStorage; `setTheme` writes localStorage. Close the
 * tab and the flag dies with `restore: 'light'` — while `localStorage.theme = 'dark'`
 * survives forever. Reproduced: a brand-new tab that had never armed anything came up
 * `{theme: 'dark', ls: 'dark', ss: null}`, with no control anywhere to undo it except
 * a theme toggle the reader has no reason to connect to a joke they used once. It also
 * destroyed "follow my system" for anyone who had never stated a theme at all.
 *
 * So arming applies dark to the DOCUMENT and does not touch storage. The theme the
 * reader chose is still their theme; the mode is just painting over it while it is on.
 */
/**
 * ★★★ THE LIGHTS GO DOWN, THEY DO NOT SNAP OFF (owner, 2026-09-19: "we need to animate
 * this a bit if possible, when clicked a slow transition into black").
 *
 * A class flip repaints every surface on the next frame, which reads as a glitch rather
 * than as a mode change. So arming adds `inquisition-dimming` to <html> for the length
 * of one transition, and a single rule in globals.css gives background, border and text
 * colour a 520ms ease on every element while it is there, and runs a 900ms sweep across
 * the viewport. `DIM_MS` below is the window the class stays on for, which has to outlast
 * the LONGEST of those, not the shortest.
 *
 * ★★ THE CLASS IS REMOVED AFTERWARDS, ON PURPOSE. Leaving a global colour transition on
 * permanently would put a 520ms lag on every hover state, every focus ring and every
 * theme token in the app for as long as the session lasts. It is on for the flip and
 * gone immediately after.
 *
 * ★ AND IT IS SKIPPED FOR ANYONE WHO ASKED FOR THAT. `prefers-reduced-motion` is
 * honoured by the CSS rule itself, so this function does not need to branch: adding the
 * class simply does nothing for those readers.
 */
/*
 * ★ 950ms BECAUSE THE SWEEP IS 900ms, and this number drifted away from the CSS once
 * already: the comment above described a 600ms cue after the stylesheet had moved to
 * 520ms colour and a 900ms sweep. A duration stated in prose has no compiler, so when
 * these disagree the prose is the one that is wrong.
 */
const DIM_MS = 950;

function withDimming(change: () => void): void {
  const root = typeof document !== 'undefined' ? document.documentElement : null;
  if (!root) {
    change();
    return;
  }
  root.classList.add('inquisition-dimming');
  change();
  window.setTimeout(() => root.classList.remove('inquisition-dimming'), DIM_MS + 60);
}

export function arm(): void {
  const state = read();
  if (state.armed) return;
  write({ armed: true, restore: readTheme() });
  withDimming(() => applyTheme('dark'));
}

export function disarm(): void {
  const state = read();
  write({ armed: false, restore: null });
  // Back to whatever they actually chose — which storage still holds, untouched.
  withDimming(() => applyTheme(state.restore ?? resolveTheme()));
}

export function toggleArm(): void {
  if (isArmed()) disarm();
  else arm();
}

/**
 * Re-applies dark on a fresh page in an armed session, and tells React when the flag
 * moves. Returns its own teardown.
 *
 * ★ THE THEME IS RE-ASSERTED ON MOUNT because the theme flag and the armed flag live
 * in different storages with different lifetimes: a reader can arm (session), close
 * the tab, reopen it — armed is gone, theme persisted — or arm and then flip the
 * theme back by hand. Whatever happened, an armed page is a dark page.
 */
export function watchArm(onChange: (armed: boolean) => void): () => void {
  const sync = () => {
    const { armed } = read();
    if (armed && readTheme() !== 'dark') applyTheme('dark');
    onChange(armed);
  };
  sync();
  window.addEventListener(ARM_EVENT, sync);
  /*
   * ★★ NO `storage` LISTENER HERE, AND THAT IS A FIX, NOT AN OMISSION. It used to
   * re-assert dark whenever ANY tab wrote `localStorage.theme` — so an armed tab left
   * open on this page silently reverted the light button in every other tab, within
   * 300ms, with no cause the reader could see. Reproduced end to end. Arming is a
   * property of THIS tab (sessionStorage); it has no business reaching into another
   * one. `ARM_EVENT` is same-tab only, which is the correct scope.
   */
  return () => {
    window.removeEventListener(ARM_EVENT, sync);
  };
}
