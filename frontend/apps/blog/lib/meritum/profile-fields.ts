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

export interface CreatorProfileFields {
  website: string | null;
  displayName: string | null;
  about: string | null;
  profileImage: string | null;
}
