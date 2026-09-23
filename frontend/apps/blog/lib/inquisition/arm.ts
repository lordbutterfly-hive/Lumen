/**
 * ════ ARMING THE MODE ════
 *
 * ★★★ ARMING FORCES DARK, AND THAT IS THE JOKE (owner, 2026-09-19: "once activated
 * ... if mode light it should automatically turn the theme black. thats the point.
 * its kind of tongue and cheek"). The lights go down when the examination starts.
 *
 * ★★ DISARMING PUTS THE READER BACK ON THEIR OWN THEME, AND ARMING NEVER TOOK ANYTHING
 * AWAY. The mode paints dark onto the document; it does not write the reader's stored
 * preference, so turning it off shows exactly the theme they chose, including one chosen
 * while the mode was on — see `arm()` for the reproduction that forced this.
 *
 * ★★ AND IT PERSISTS LIKE THE THEME DOES (owner, 2026-09-23: "inquisition mode should
 * persist if you turned it on just like your theme should persist if you set it dark or
 * light"). It was `sessionStorage`, so a new tab came up disarmed, and because only this
 * file re-applied dark, reloading any page outside the boards and the profile strip came
 * up light mid-session. The flag is now `localStorage['inquisition']`, read by the inline
 * head script in lib/theme.ts before the first paint, so every page of an armed reader is
 * dark from its first frame, in every tab, until they turn it off.
 */

import { INQUISITION_STORAGE_KEY, applyTheme, readTheme, resolveTheme } from '@/blog/lib/theme';

export const ARM_KEY = INQUISITION_STORAGE_KEY;
export const ARM_EVENT = 'lumen:inquisition';

function read(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(ARM_KEY) === '1';
  } catch {
    return false;
  }
}

function write(armed: boolean): void {
  try {
    if (armed) window.localStorage.setItem(ARM_KEY, '1');
    else window.localStorage.removeItem(ARM_KEY);
  } catch {
    // Blocked storage: the mode still applies to this page, it just will not survive
    // a reload. Failing to persist must never fail to arm.
  }
  window.dispatchEvent(new CustomEvent(ARM_EVENT));
}

export function isArmed(): boolean {
  return read();
}

/**
 * ★★★ ARMING NO LONGER WRITES THE READER'S THEME PREFERENCE (found by adversarial
 * review, 2026-09-19, and it is exactly the harm the note at the top of this file says
 * a joke has no right to do).
 *
 * The armed flag lived in sessionStorage then, and arming called `setTheme`, which
 * writes localStorage. Close the tab and the flag died with `restore: 'light'` — while
 * `localStorage.theme = 'dark'`
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
  if (read()) return;
  write(true);
  withDimming(() => applyTheme('dark'));
}

export function disarm(): void {
  write(false);
  // Back to whatever they actually chose — which storage still holds, untouched.
  withDimming(() => applyTheme(resolveTheme()));
}

export function toggleArm(): void {
  if (isArmed()) disarm();
  else arm();
}

/**
 * Re-applies dark on a fresh page in an armed session, and tells React when the flag
 * moves. Returns its own teardown.
 *
 * ★ THE THEME IS RE-ASSERTED ON MOUNT as a backstop: the head script already paints an
 * armed page dark before first paint, but a page React re-rendered from scratch (the
 * error path, see theme-keeper.tsx) loses it. Whatever happened, an armed page is dark.
 */
export function watchArm(onChange: (armed: boolean) => void): () => void {
  const sync = () => {
    const armed = read();
    if (armed && readTheme() !== 'dark') applyTheme('dark');
    onChange(armed);
  };
  /*
   * ★★ THE `storage` LISTENER HERE WATCHES THE MODE'S OWN KEY AND NOTHING ELSE. An earlier
   * one re-asserted dark whenever ANY tab wrote `localStorage.theme`, so an armed tab left
   * open silently reverted the light button in every other tab within 300ms (reproduced
   * end to end). Arming is one setting for the whole browser now (2026-09-23), so another
   * tab turning it on or off must move this tab's pill and strip; a theme write never
   * reaches this listener, and lib/theme.ts `watchTheme` is what repaints the page.
   */
  const onStorage = (event: StorageEvent) => {
    if (event.key === ARM_KEY) onChange(event.newValue === '1');
  };
  sync();
  window.addEventListener(ARM_EVENT, sync);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(ARM_EVENT, sync);
    window.removeEventListener('storage', onStorage);
  };
}
