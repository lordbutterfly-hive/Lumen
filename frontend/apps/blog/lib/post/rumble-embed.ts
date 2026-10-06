/**
 * The pure half of Rumble embeds (2026-10-06): validation of what the page sends, the
 * oEmbed URL we ask, and reading the player id out of Rumble's answer. No fetch and no
 * Next imports, so `test:unit` can load it.
 *
 * Why a lookup at all: a Rumble PAGE link (`rumble.com/v6ur90f-<title>.html`, what
 * people post) and its PLAYER (`rumble.com/embed/v6skcrl/`) use different ids, and
 * only Rumble's oEmbed API maps one to the other (measured: `embed/v6ur90f/` answers
 * 410 "Video not found"). The renderer emits a `rumble-facade` with the page path;
 * the post page asks `/api/embed/rumble` after load and swaps the player in.
 */

/** `<pageId>-<title>`, as RumbleEmbedder puts it in `data-rumble-page`. The title is
 *  not needed by Rumble (any title resolves the same id) but is sent as written. */
const PAGE_RE = /^(v[a-z0-9]{3,12})-([\w-]{1,200})$/i;
const EMBED_ID_RE = /^[a-z0-9]{4,20}$/i;
const OEMBED_SRC_RE = /src=\\?"https:\/\/rumble\.com\/embed\/([a-z0-9]{4,20})\/\\?"/i;

export interface RumblePage {
  /** The page id alone (`v6ur90f`): the cache key, since the title does not change the answer. */
  pageId: string;
  /** The full `<pageId>-<title>` path, used to build the URL Rumble is asked about. */
  page: string;
}

export function parseRumblePage(raw: string | null | undefined): RumblePage | null {
  if (!raw) return null;
  const m = raw.match(PAGE_RE);
  if (!m) return null;
  return { pageId: m[1].toLowerCase(), page: raw };
}

export function rumbleOembedUrl(page: RumblePage): string {
  return `https://rumble.com/api/Media/oembed.json?url=${encodeURIComponent(`https://rumble.com/${page.page}.html`)}`;
}

/** The player id from an oEmbed answer's `html` (`<iframe src="https://rumble.com/embed/<id>/" ...>`), or null. */
export function embedIdFromOembed(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const html = (body as { html?: unknown }).html;
  if (typeof html !== 'string') return null;
  const m = html.match(OEMBED_SRC_RE);
  return m ? m[1] : null;
}

/** True for an id that may be put in `https://rumble.com/embed/<id>/` (the client re-checks the API's answer). */
export function isRumbleEmbedId(id: unknown): id is string {
  return typeof id === 'string' && EMBED_ID_RE.test(id);
}
