import {Log} from '../../../../Log';
import {AbstractEmbedder, EmbedMetadata} from './AbstractEmbedder';

export class VimeoEmbedder extends AbstractEmbedder {
    public type = 'vimeo';

    /**
     * Group 1: the numeric video id. Accepted (2026-10-06): `vimeo.com/<id>`,
     * `www.vimeo.com/<id>`, `vimeo.com/channels/<name>/<id>`,
     * `vimeo.com/groups/<name>/videos/<id>` and `player.vimeo.com/video/<id>`. The
     * whole link (query included) is consumed so no `?share=copy` tail is left behind
     * as text beside the player.
     */
    private static readonly regex =
        /https?:\/\/(?:(?:www\.)?vimeo\.com\/(?:channels\/[\w-]{1,64}\/|groups\/[\w-]{1,64}\/videos\/)?|player\.vimeo\.com\/video\/)(\d{1,12})(?!\d)[^\s]*/i;

    /**
     * An UNLISTED video only plays with its privacy hash, which Vimeo puts in the
     * share link as a path segment (`vimeo.com/<id>/<hash>`) and in its own embed code
     * as `?h=<hash>`. Dropping it (the old behaviour) leaves a player that refuses the
     * video, so it is carried in the embed id as `<id>/<hash>`.
     */
    private static readonly hashInQuery = /[?&]h=([0-9a-f]{6,20})(?:[&#]|$)/i;
    private static readonly embedId = /^(\d{1,12})(?:\/([0-9a-f]{6,20}))?$/i;

    public getEmbedMetadata(child: HTMLObjectElement): EmbedMetadata | undefined {
        try {
            const data = child.data;
            const metadata = this.extractMetadata(data);
            if (!metadata) {
                return undefined;
            }
            return {
                id: metadata.id,
                url: metadata.url
            };
        } catch (error) {
            Log.log().error(error);
        }
        return undefined;
    }

    public processEmbed(id: string, size: {width: number; height: number}): string {
        // Re-validated here: the marker text this id comes from can be typed into a post by hand.
        const url = VimeoEmbedder.generateCanonicalUrl(id);
        if (!url) return '';
        return `<div class="videoWrapper"><iframe src="${url}" width="${size.width}" height="${size.height}" frameBorder="0" webkitallowfullscreen mozallowfullscreen allowFullScreen></iframe></div>`;
    }

    /** `https://player.vimeo.com/video/<id>[?h=<hash>]`, or null for anything that is not a valid embed id. */
    public static generateCanonicalUrl(id: string): string | null {
        const m = id.match(VimeoEmbedder.embedId);
        if (!m) return null;
        return `https://player.vimeo.com/video/${m[1]}` + (m[2] ? `?h=${m[2]}` : '');
    }

    private extractMetadata(data: string) {
        if (!data) {
            return null;
        }
        const m = data.match(VimeoEmbedder.regex);
        if (!m || m.length < 2) {
            return null;
        }
        const url = m[0];
        // The path hash must sit directly after THIS id (`m[1]` is digits only, so it is
        // safe in a pattern); a looser match took the id of `channels/123456/<id>` for a hash.
        const hashInPath = new RegExp(`/${m[1]}/([0-9a-f]{6,20})(?:[/?#]|$)`, 'i');
        const hash = url.match(hashInPath) || url.match(VimeoEmbedder.hashInQuery);
        return {
            id: hash ? `${m[1]}/${hash[1]}` : m[1],
            url
        };
    }
}
