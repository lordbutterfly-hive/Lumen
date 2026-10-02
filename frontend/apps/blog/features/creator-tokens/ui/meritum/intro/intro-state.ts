/**
 * The Meritum intro's open/closed choice for readers who already have a token.
 *
 * A COOKIE, not localStorage, so the server renders the reader's own choice on
 * the first paint and the card never jumps open or shut after hydration. Kept in
 * this plain module (no 'use client') because `app/creators/page.tsx` reads the
 * name on the server, and a value imported from a client module arrives there as
 * a client reference, not the string.
 *
 * Only signed-in readers ever see the toggle, and signed-in HTML bypasses the
 * shared edge cache (Caddyfile), so the cookie never reaches a cached page.
 */
export const MERITUM_INTRO_OPEN_COOKIE = 'lumen_meritum_intro';
export const MERITUM_INTRO_OPEN_VALUE = 'open';

/**
 * The live choice in the browser. The client router can hand back a cached
 * /creators payload rendered before the reader last flipped the bar, so a
 * client-side mount trusts the cookie, not the payload. Null on the server.
 */
export function readMeritumIntroOpen(): boolean | null {
  if (typeof document === 'undefined') return null;
  return document.cookie
    .split(';')
    .some((c) => c.trim() === `${MERITUM_INTRO_OPEN_COOKIE}=${MERITUM_INTRO_OPEN_VALUE}`);
}
