import { stripInvisibleAndBidi } from '@ui/lib/text-safety';
import { LumenProfile } from '../types';

/**
 * Validation for the editable profile of a lite account.
 *
 * These values are rendered into other people's pages — as an `<img src>` for the two
 * image fields and as a link for the website — so they are never stored as given.
 * Anything that is not an ordinary http(s) URL is dropped rather than corrected:
 * `javascript:` and `data:` URLs are the classic way a profile field becomes stored
 * XSS, and silently keeping "most of" a hostile value is how that happens.
 *
 * Lengths are bounded for the same reason Hive bounds them — a profile is a few
 * lines, and an unbounded one is a free content host.
 */

const LIMITS = {
  name: 40,
  about: 200,
  location: 40,
  website: 200,
  profile_image: 500,
  cover_image: 500
} as const;

/**
 * ★★ INVISIBLE AND DIRECTION-REVERSING CHARACTERS ARE NOT TEXT (2026-08-09).
 *
 * This stripped C0/C1 controls and the line separators, which stops a one-line
 * field impersonating several. It did NOT strip two other classes that a QA
 * tester drove all the way to the rendered public profile:
 *
 *  - **U+200B zero-width space.** It survives `trim()` (JS trim does not treat
 *    it as whitespace), so it passed the non-empty check and saved. The profile
 *    header then rendered COMPLETELY BLANK — a nameless account, no explanation.
 *  - **U+202E RIGHT-TO-LEFT OVERRIDE.** Saved verbatim, and the browser honours
 *    it: a stored name of `evilname-RTL` rendered as "LTR-emanlive". That is the
 *    Trojan-Source/bidi username-spoofing shape — a name can be chosen to
 *    display as somebody else's, and nothing on the page hints it happened.
 *
 * Both are impersonation primitives on a social product, so they are REMOVED
 * rather than escaped: no legitimate display name needs a zero-width space or an
 * explicit direction override to render correctly. Ordinary right-to-left names
 * are unaffected — Arabic and Hebrew letters carry their own strong
 * directionality and are not in these ranges.
 *
 * Removed (not replaced by a space — these are zero-width by definition):
 *   U+200B-U+200F  zero-width space/NJ/J, LRM, RLM
 *   U+202A-U+202E  LRE/RLE/PDF/LRO/RLO   explicit bidi embedding + override
 *   U+2066-U+2069  LRI/RLI/FSI/PDI       bidi isolates (modern equivalents)
 *   U+FEFF         zero-width no-break space / BOM
 */
// ★ NOW THE SHARED DEFINITION (2026-08-23). This was a local regex, and it was BOTH
// over- and under-inclusive: it swallowed U+200C ZWNJ (required in Persian/Farsi
// orthography) and U+200D ZWJ (which builds emoji sequences — `👩‍💻` came out as two
// glyphs), while missing U+061C ARABIC LETTER MARK and U+2060 WORD JOINER, which are real
// invisibles. The shared version in `@ui/lib/text-safety` fixes both directions and is the
// SAME definition the chain read path now uses (`packages/transaction/lib/hive-api.ts`), so
// the two cannot drift. The C0/C1 replacement and the truncation below are unchanged —
// those are write-side field policy and stay local.

function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  // Strip control characters (including the line separators that let a one-line
  // field impersonate several) and collapse the rest.
  const cleaned = stripInvisibleAndBidi(
    value.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ')
  ).trim();
  return cleaned.slice(0, max);
}

/** An http(s) URL, or empty string. Never throws — an invalid URL is simply absent. */
export function safeUrl(value: unknown, max: number): string {
  const raw = text(value, max);
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.toString().slice(0, max);
  } catch {
    return '';
  }
}

export function sanitizeProfile(input: unknown): LumenProfile {
  const raw = (input ?? {}) as Record<string, unknown>;
  return {
    name: text(raw.name, LIMITS.name),
    about: text(raw.about, LIMITS.about),
    location: text(raw.location, LIMITS.location),
    website: safeUrl(raw.website, LIMITS.website),
    profile_image: safeUrl(raw.profile_image, LIMITS.profile_image),
    cover_image: safeUrl(raw.cover_image, LIMITS.cover_image)
  };
}
