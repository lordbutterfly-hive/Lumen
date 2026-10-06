import {Log} from '../../../../Log';
import {AbstractEmbedder, EmbedMetadata} from './AbstractEmbedder';

/**
 * Embedder for BitChute videos.
 *
 * Supported URL formats:
 * - https://www.bitchute.com/video/VIDEO_ID/
 * - https://bitchute.com/embed/VIDEO_ID/
 * - https://old.bitchute.com/video/VIDEO_ID/
 *
 * Only the id is carried over; the player is rebuilt on www.bitchute.com/embed/.
 */
export class BitChuteEmbedder extends AbstractEmbedder {
    public type = 'bitchute';

    /**
     * Group 1: video id. The negative lookahead stops the id at its last valid
     * character, so a longer run of id characters never matches a prefix of it.
     */
    private static readonly linkRegex = /https?:\/\/(?:(?:www|old)\.)?bitchute\.com\/(?:video|embed)\/([\w-]{6,32})(?![\w-])\/?(?:[?#][^\s]*)?/i;

    public getEmbedMetadata(input: string | HTMLObjectElement): EmbedMetadata | undefined {
        const data = typeof input === 'string' ? input : input.data;
        try {
            const match = data.match(BitChuteEmbedder.linkRegex);
            if (match && match[1]) {
                return {
                    id: match[1],
                    url: match[0]
                };
            }
        } catch (error) {
            Log.log().error(error);
        }
        return undefined;
    }

    public processEmbed(id: string, size: {width: number; height: number}): string {
        return `<div class="videoWrapper"><iframe src="https://www.bitchute.com/embed/${id}/" width="${size.width}" height="${size.height}" frameborder="0" allowfullscreen></iframe></div>`;
    }
}
