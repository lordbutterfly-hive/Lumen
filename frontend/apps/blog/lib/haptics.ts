/**
 * ════ HAPTICS ════
 *
 * Three patterns, one API. The whole point is that a physical confirmation lands before
 * the network does — the tap feels acknowledged instantly even when the broadcast takes
 * two seconds, which is most of what "responsive" actually means on a phone.
 *
 * ★ WHERE THE PATTERNS COME FROM. They are not arbitrary durations, they encode weight:
 *
 *   vote    8ms           — a tick. The lightest thing the API can express. Votes are
 *                           frequent and reversible; anything longer becomes nagging by
 *                           the twentieth one.
 *   publish [12, 40, 12]  — two taps around a pause. A "done" shape, for something that
 *                           left the device and is not coming back.
 *   strike  [20, 60, 30]  — heavier, and it ENDS heavy. This is the irreversible one
 *                           (a creator token is minted once, bound to one account,
 *                           forever), so the last thing felt is the longest.
 *
 * ★★ IT IS BEST-EFFORT BY CONSTRUCTION, AND THAT IS THE CORRECT POSTURE.
 *
 * `navigator.vibrate` is absent on desktop Safari and all of iOS Safari, needs a prior
 * user gesture in Chrome, silently no-ops when the device is in silent/low-power mode,
 * and throws in some embedded webviews. NONE of that is an error worth surfacing: haptics
 * are a garnish on an action whose real feedback is the UI updating. So every call is
 * wrapped and every failure is swallowed.
 *
 * The one thing that would be a bug is a haptic firing on an action that then FAILS —
 * telling the hand "done" while the network says otherwise. Call these on SUCCESS, never
 * on click.
 *
 * ★ REDUCED MOTION IS RESPECTED. Someone who has asked the OS to stop moving things has
 * asked for less sensory noise, and a vibration is sensory noise. `prefers-reduced-motion`
 * is the closest signal the platform gives us to that preference.
 */

export type HapticPattern = 'vote' | 'publish' | 'strike';

const PATTERNS: Record<HapticPattern, number | number[]> = {
  vote: 8,
  publish: [12, 40, 12],
  strike: [20, 60, 30]
};

function reducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Fire a haptic. Returns whether the device actually accepted it — useful in a test, and
 * ignorable everywhere else.
 *
 * Safe to call during SSR, on desktop, in a webview, and on a device that has vibration
 * disabled. It will simply do nothing.
 */
export function haptic(pattern: HapticPattern): boolean {
  try {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
    if (typeof navigator.vibrate !== 'function') return false;
    if (reducedMotion()) return false;
    return navigator.vibrate(PATTERNS[pattern]);
  } catch {
    // A webview that throws on vibrate must not take the surrounding success handler
    // down with it — the post published; the buzz is the least important part.
    return false;
  }
}

/** The raw patterns, for tests and for anyone tuning the feel. */
export const HAPTIC_PATTERNS = PATTERNS;
