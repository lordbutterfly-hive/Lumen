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

function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  // Strip control characters (including the line separators that let a one-line
  // field impersonate several) and collapse the rest.
  const cleaned = value.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').trim();
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
