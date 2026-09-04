/**
 * ★ 3SPEAK INLINE PLAYER FROM METADATA (2026-09-04, owner request via tibfox).
 *
 * A 3speak post carries the canonical embed target in `json_metadata.video.url`
 * (e.g. https://play.3speak.tv/embed?v=badadib/g9sgdk5h). This turns that into a
 * bare 3speak URL the renderer's ThreeSpeakEmbedder + iframe allowlist render as
 * a sandboxed player — WITHOUT the post body needing to carry the URL itself.
 *
 * ★★ video.url IS ATTACKER-CONTROLLED (json_metadata is author-set), so it is
 * NEVER trusted as an iframe src. It is PARSED with `new URL()` and accepted only
 * when the hostname is an EXACT match against the 3speak host set (hostname
 * equality — not startsWith/includes/substring, which fall to suffix
 * `3speak.tv.evil.com`, userinfo `3speak.tv@evil.com`, and substring tricks), the
 * scheme is https, and the `v` id is the Hive handle/permlink shape. Only then is
 * a hardcoded `https://3speak.tv/embed?v=<id>` returned — the same rebuild the
 * allowlist would do anyway, so this is defence in depth, not the only gate.
 */

const THREESPEAK_HOSTS = new Set(['3speak.tv', 'play.3speak.tv', '3speak.online', '3speak.co']);
const V_ID = /^[a-z0-9][a-z0-9.-]{1,15}\/[a-z0-9][a-z0-9-]*$/;

/** A safe `https://3speak.tv/embed?v=<id>` for a valid 3speak video url, else null. */
export function threeSpeakEmbedUrl(videoUrl: unknown): string | null {
  if (typeof videoUrl !== 'string' || videoUrl.length === 0 || videoUrl.length > 512) return null;
  let u: URL;
  try {
    u = new URL(videoUrl);
  } catch {
    return null; // relative / protocol-relative / malformed => reject
  }
  if (u.protocol !== 'https:') return null;
  // hostname equality (URL parsing has already stripped userinfo and normalised case)
  const host = u.hostname.replace(/\.$/, '').toLowerCase();
  if (!THREESPEAK_HOSTS.has(host)) return null;
  const v = u.searchParams.get('v');
  if (!v || !V_ID.test(v)) return null;
  return `https://3speak.tv/embed?v=${v}`;
}

interface VideoMeta {
  platform?: unknown;
  url?: unknown;
}

/**
 * Returns the body with a validated 3speak player prepended when the post's
 * metadata names a 3speak video AND the body does not already embed one (so we
 * never render the player twice). Otherwise returns the body unchanged.
 */
export function bodyWithThreeSpeakPlayer(body: string, jsonMetadata: unknown): string {
  const video = (jsonMetadata as { video?: VideoMeta } | null | undefined)?.video;
  if (!video || video.platform !== '3speak') return body;
  const embed = threeSpeakEmbedUrl(video.url);
  if (!embed) return body;
  // Double-render guard: if the body already carries ANY 3speak watch/embed link,
  // the ThreeSpeakEmbedder renders it there; don't add a second player.
  if (/3speak\.(?:tv|online|co)\/(?:watch|embed)\?v=/i.test(body)) return body;
  return `${embed}\n\n${body}`;
}
