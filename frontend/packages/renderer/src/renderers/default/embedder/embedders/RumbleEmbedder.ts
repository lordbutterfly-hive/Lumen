import {Log} from '../../../../Log';
import {AbstractEmbedder, EmbedMetadata} from './AbstractEmbedder';

/**
 * Embedder for Rumble videos (2026-10-06).
 *
 * - `https://rumble.com/embed/<embedId>/` (a player link) renders the player directly.
 * - `https://rumble.com/<pageId>-<title>.html` (what people actually post) cannot:
 *   Rumble's player uses a DIFFERENT id from the page (`v6ur90f` plays as `v6skcrl`;
 *   `embed/v6ur90f/` answers 410 "Video not found"), and the mapping is only available
 *   from Rumble's oEmbed API. That is a network call, which has no place in a render,
 *   so this emits a `rumble-facade` holding the page path plus a plain "Watch on
 *   Rumble" link; the post page (`rendererContainer.tsx`) asks `/api/embed/rumble` for
 *   the player id after load and swaps the player in. If the lookup fails, the link
 *   stays, which is what the post showed before.
 *
 * The marker id is `e-<embedId>[.<pub>]` or `p-<pageId>-<title>`; both are re-validated
 * in processEmbed because a marker can be typed into a post by hand.
 */
export class RumbleEmbedder extends AbstractEmbedder {
    public type = 'rumble';

    private static readonly linkRegex = /https?:\/\/(?:www\.)?rumble\.com\/(?:(v[a-z0-9]{3,12}-[\w-]{1,200})\.html|embed\/([a-z0-9]{4,20})(?![a-z0-9])\/?)[^\s]*/i;
    private static readonly pubRegex = /[?&]pub=([a-z0-9]{1,20})(?:[&#]|$)/i;
    private static readonly embedIdRe = /^e-([a-z0-9]{4,20})(?:\.([a-z0-9]{1,20}))?$/i;
    private static readonly pageIdRe = /^p-(v[a-z0-9]{3,12}-[\w-]{1,200})$/i;

    public getEmbedMetadata(input: string | HTMLObjectElement): EmbedMetadata | undefined {
        const data = typeof input === 'string' ? input : input.data;
        try {
            const m = data.match(RumbleEmbedder.linkRegex);
            if (!m) return undefined;
            if (m[1]) return {id: `p-${m[1]}`, url: m[0]};
            const pub = m[0].match(RumbleEmbedder.pubRegex);
            return {id: `e-${m[2]}` + (pub ? `.${pub[1]}` : ''), url: m[0]};
        } catch (error) {
            Log.log().error(error);
        }
        return undefined;
    }

    public processEmbed(id: string, size: {width: number; height: number}): string {
        const e = id.match(RumbleEmbedder.embedIdRe);
        if (e) {
            const src = `https://rumble.com/embed/${e[1]}/` + (e[2] ? `?pub=${e[2]}` : '');
            return `<div class="videoWrapper"><iframe src="${src}" width="${size.width}" height="${size.height}" frameborder="0" allowfullscreen></iframe></div>`;
        }
        const p = id.match(RumbleEmbedder.pageIdRe);
        if (p) {
            return `<div class="rumble-facade" data-rumble-page="${p[1]}"><a href="https://rumble.com/${p[1]}.html" target="_blank" rel="noopener noreferrer nofollow">Watch on Rumble</a></div>`;
        }
        return '';
    }
}
