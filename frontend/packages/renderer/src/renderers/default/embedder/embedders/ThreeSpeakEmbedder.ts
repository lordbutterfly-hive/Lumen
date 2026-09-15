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

    // ★★★ THE PLAYER LIVES ON `play.3speak.tv`, NOT ON `3speak.tv` (2026-09-10,
    // owner: "3speak window does not work on Lumne, go find out why").
    //
    // MEASURED, not inferred, in Chrome against a real post
    // (`daveks/bugaboo-falls-695`, whose `json_metadata.video.url` is
    // `https://play.3speak.tv/embed?v=daveks/hfvwpv7q`):
    //   https://3speak.tv/embed?v=daveks/hfvwpv7q       -> 200, but the SPA shell
    //       renders "SORRY! PAGE NOT FOUND". 0 <video> elements. 3speak.tv is now a
    //       client-routed app that has no /embed route, and its index.html answers
    //       200 for every path, so nothing upstream of the browser can see the 404.
    //   https://play.3speak.tv/embed?v=daveks/hfvwpv7q  -> "3speak Video Player",
    //       2 <video> elements, live `blob:` source. This is the real player.
    //
    // The 2026-09-04 hardening that introduced the rebuild was right about the
    // METHOD (never echo the author's host back; emit one hardcoded literal) and
    // simply picked the host that has since stopped serving embeds. The security
    // property is unchanged: still a single hardcoded origin, still only the
    // charset-checked id from `linkRegex` interpolated into it.
    public processEmbed(id: string, size: {width: number; height: number}): string {
        // ★ ONE WINDOW, SET SIZE (owner, 2026-09-15: "theres a weird scroll on them
        // instead of it being a single window at set size"). Without `mode=iframe`
        // this URL is 3speak's full player PAGE: logo header, "Video Info" panel,
        // 20px paddings, and a player that takes the video's own aspect ratio, so
        // a portrait video ran 1223px tall inside our 390px box and scrolled.
        // 3speak's own embed guide (play.3speak.tv/embed-demo.html): `mode=iframe`
        // "hides the header and info panel for a clean, embeddable experience",
        // `layout=desktop` "maintains a strict 16:9 aspect ratio like YouTube ...
        // perfect for web embeds". hive.blog and 3speak.tv's own renderer emit the
        // same pair. Both are literals appended after the charset-checked id.
        //
        // `videoWrapper` directly, like YouTube/Twitch/Vimeo, so the 16:9 box
        // exists in the server HTML; `threeSpeakWrapper` had no CSS and only
        // became a videoWrapper in a client effect after hydration, which is why
        // the frame first painted at 640x480 and then jumped.
        const embedUrl = `https://play.3speak.tv/embed?v=${id}&mode=iframe&layout=desktop`;
        return `<div class="videoWrapper"><iframe width="${size.width}" height="${size.height}" src="${embedUrl}" frameborder="0" allowfullscreen></iframe></div>`;
    }
}
