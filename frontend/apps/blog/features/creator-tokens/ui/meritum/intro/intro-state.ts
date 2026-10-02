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
 * ★ "THIS ACCOUNT HAS A TOKEN", REMEMBERED FOR THE NEXT FIRST PAINT (2026-10-02).
 *
 * The server can only answer for a Hive account, and only when the chain read
 * lands within its deadline. A wallet (lite) creator, or a slow read, used to
 * paint the full card and the launch box and then snap them shut once the
 * browser's own read landed (measured CLS 0.25 at 1440, 0.46 at 390). The
 * browser's answer is now kept here, keyed by the signed-in account name so a
 * second account on the same browser is never folded by the first one's token,
 * and app/creators/page.tsx uses it whenever the chain gave no answer. A definite
 * answer from the chain always wins.
 */
export const MERITUM_HAS_TOKEN_COOKIE = 'lumen_has_token';

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  for (const part of document.cookie.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

/** Keep the cookie in step with the browser's answer; writes only on a change. */
export function rememberHasToken(username: string, hasToken: boolean): void {
  if (typeof document === 'undefined' || username === '') return;
  const current = readCookie(MERITUM_HAS_TOKEN_COOKIE);
  try {
    if (hasToken && current !== username) {
      document.cookie = `${MERITUM_HAS_TOKEN_COOKIE}=${encodeURIComponent(username)}; path=/; max-age=31536000; samesite=lax`;
    } else if (!hasToken && current === username) {
      document.cookie = `${MERITUM_HAS_TOKEN_COOKIE}=; path=/; max-age=0; samesite=lax`;
    }
  } catch {
    // Cookies blocked: the page still corrects itself after the read lands.
  }
}

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
