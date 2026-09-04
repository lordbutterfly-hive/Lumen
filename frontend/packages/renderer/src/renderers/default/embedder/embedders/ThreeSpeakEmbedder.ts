import {Log} from '../../../../Log';
import {AbstractEmbedder, EmbedMetadata} from './AbstractEmbedder';

export class ThreeSpeakEmbedder extends AbstractEmbedder {
    public type = '3speak';

    /**
     * Matches 3Speak video URLs.
     * Video IDs are in format: username/permlink (Hive account format)
     * - Username: lowercase alphanumeric, dots, dashes (2-16 chars)
     * - Permlink: lowercase alphanumeric, dashes
     */
    // ★ ANCHORED + play./www. subdomains explicit (2026-09-04). Was unanchored, so
    // it substring-matched `3speak.tv/embed?v=` inside ANY larger URL (e.g.
    // https://evil.com/?x=3speak.tv/watch?v=a/b) and rendered a 3speak embed there;
    // and `play.3speak.tv` (the host json_metadata.video.url actually uses) only
    // matched by accident (the `3speak.tv` substring of `play.3speak.tv`). Now the
    // whole token must BE a 3speak url. The id stays lowercase-strict (Hive handle
    // rules); the emitted src is rebuilt to a hardcoded 3speak.tv host in processEmbed.
    private static readonly linkRegex = /^(?:https?:\/\/)?(?:(?:play|www)\.)?3[sS]peak\.(?:tv|online|co)\/(?:watch|embed)\?v=([a-z0-9][a-z0-9.-]{1,15}\/[a-z0-9][a-z0-9-]*)/;

    public getEmbedMetadata(input: string | HTMLObjectElement): EmbedMetadata | undefined {
        const url = typeof input === 'string' ? input : input.data;
        try {
            // Clean the URL by trimming whitespace and removing leading newlines
            const cleanUrl = url.trim().replace(/^\n+/, '');

            // Check if this contains a 3speak URL
            const match = cleanUrl.match(ThreeSpeakEmbedder.linkRegex);
            if (match && match[1]) {
                const id = match[1];
                return {
                    id,
                    url: match[0] // Return the matched URL part
                };
            }
        } catch (error) {
            Log.log().error(error);
        }
        return undefined;
    }

    public processEmbed(id: string, size: {width: number; height: number}): string {
        const embedUrl = `https://3speak.tv/embed?v=${id}`;
        return `<div class="threeSpeakWrapper"><iframe width="${size.width}" height="${size.height}" src="${embedUrl}" frameborder="0" allowfullscreen></iframe></div>`;
    }
}
