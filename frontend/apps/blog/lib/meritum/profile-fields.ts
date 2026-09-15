/**
 * The two Hive-profile fields the Meritum creator page shows verbatim
 * (handoff §1/§2): `json_metadata.profile.about` and `profile.profile_image`.
 * Both are ATTACKER-CONTROLLED TEXT — anyone can put anything in their own
 * profile, and this page renders it on a public, crawlable, shareable URL and
 * into an image that gets scraped once and cached. So both are shaped here,
 * once, server-side, before they reach a page, an API answer or the card:
 *
 * - `about`: plain text only. Control characters and zero-width/bidi
 *   overrides are dropped (a right-to-left override can make "Buy" read as a
 *   different word beside a price), whitespace collapses, length is capped.
 *   React escapes markup on the page; the card renders through Satori, which
 *   draws text, not HTML. Neither ever sees a `<`-bearing string as markup.
 * - `profile_image`: an `https:` URL with a host, no credentials, no
 *   fragment, bounded length. Nothing else — never `javascript:`, `data:`,
 *   `http:` (mixed content) or an IP literal. The page loads it through the
 *   browser like any image; the card does NOT fetch it from the server at
 *   all (see the card route: an arbitrary URL fetched by our server is an
 *   SSRF hole), it asks Hive's own image proxy by account name instead.
 */

export const ABOUT_MAX_CHARS = 280;
export const PROFILE_IMAGE_MAX_CHARS = 512;

// C0/C1 controls (tab, newline and carriage return are left for the whitespace
// collapse below), plus the invisible-formatting range (zero-width joiners and
// the bidi overrides U+202A-202E / U+2066-2069) and the byte-order mark.
// eslint-disable-next-line no-control-regex
const STRIP = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

export function sanitizeAbout(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(STRIP, '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > ABOUT_MAX_CHARS ? truncateOnWord(text, ABOUT_MAX_CHARS) : text;
}

/** Truncate on a WORD, never mid-word, with a visible ellipsis so a reader knows it was cut. */
export function truncateOnWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.4 ? cut.slice(0, lastSpace) : cut).replace(/[\s.,;:!?-]+$/, '')}…`;
}

export function sanitizeProfileImage(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > PROFILE_IMAGE_MAX_CHARS) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (!url.hostname || !url.hostname.includes('.')) return null;
  // An IP literal is never a public image host; it is how a server is pointed at itself.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname) || url.hostname.startsWith('[')) return null;
  url.hash = '';
  return url.toString();
}

export const DISPLAY_NAME_MAX_CHARS = 64;

/** The one field that had no gate (review, 2026-09-15): plain text, controls stripped, bounded. */
export function sanitizeDisplayName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(STRIP, '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return Array.from(text).slice(0, DISPLAY_NAME_MAX_CHARS).join('');
}

/** Roughly how wide a character is on a card: CJK, fullwidth and emoji take two columns, the rest one. */
function columnsOf(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || cp >= 0x1f300)) return 2;
  return 1;
}

/**
 * Truncate to a number of COLUMNS, not characters (review, 2026-09-15): 110
 * CJK characters are three lines where 110 Latin ones are two, and a card
 * clips the third line with no cue. Cuts on a space when one is near the
 * limit, otherwise on a character boundary (CJK has no spaces), always with
 * the ellipsis.
 */
export function truncateToColumns(text: string, maxColumns: number): string {
  const chars = Array.from(text);
  let used = 0;
  let end = chars.length;
  for (let i = 0; i < chars.length; i++) {
    used += columnsOf(chars[i]);
    if (used > maxColumns) {
      end = i;
      break;
    }
  }
  if (end >= chars.length) return text;
  const head = chars.slice(0, end).join('');
  const lastSpace = head.lastIndexOf(' ');
  const cut = lastSpace > head.length * 0.6 ? head.slice(0, lastSpace) : head;
  return `${cut.replace(/[\s.,;:!?-]+$/, '')}…`;
}

export type CreatorProfileSource = 'hive' | 'lite' | 'none';

export interface CreatorProfileFields {
  website: string | null;
  displayName: string | null;
  about: string | null;
  profileImage: string | null;
  /** Which store answered: decides whose FACE a surface may show (a lite-owned name must never wear the Hive squatter's picture). */
  source: CreatorProfileSource;
}
