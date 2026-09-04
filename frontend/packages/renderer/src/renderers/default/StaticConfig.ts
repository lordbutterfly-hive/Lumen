/**
 * This file is based on
 *  - https://github.com/openhive-network/condenser/blob/master/src/app/utils/SanitizeConfig.js
 */

/**
 * Static configuration class for content sanitization and iframe handling.
 *
 * This class provides configuration settings for:
 * - Whitelisted iframe sources with their validation and transformation rules
 * - Text to display when images are hidden due to low ratings
 * - Allowed HTML tags for content rendering
 *
 * The iframe whitelist includes support for:
 * - Twitter/X.com embedded tweets
 * - Vimeo video embeds
 * - YouTube video embeds
 * - SoundCloud audio players
 * - Twitch.tv video players
 * - Spotify embeds (playlists, shows, episodes, albums, tracks, artists)
 * - 3speak video embeds
 */
export class StaticConfig {
    public static sanitization = {
        iframeWhitelist: [
            {
                // eslint-disable-next-line security/detect-unsafe-regex
                re: /^(?:@?(?:https?:)?\/\/)?(?:www\.)?(twitter|x)\.com\/(?:\w+\/status|status)\/(\d{1,20})/i,
                fn: (src: string) => {
                    if (!src) {
                        return null;
                    }
                    const cleanSrc = src.replace(/^(@|https?:\/\/)/, '');
                    const match = cleanSrc.match(/(?:twitter|x)\.com\/(?:\w+\/status|status)\/(\d{1,20})/i);
                    if (!match || match.length !== 2) {
                        return null;
                    }
                    return `https://platform.twitter.com/embed/Tweet.html?id=${match[1]}`;
                }
            },
            {
                // Dots escaped for hygiene (2026-09-04); the fn already re-validated with
                // a strict escaped regex + rebuilt the host, so this was never exploitable.
                re: /^(?:https?:)?\/\/player\.vimeo\.com\/video\/.*/i,
                fn: (src: string) => {
                    // <iframe src="https://player.vimeo.com/video/179213493" width="640" height="360" frameborder="0" webkitallowfullscreen mozallowfullscreen allowfullscreen></iframe>
                    if (!src) {
                        return null;
                    }
                    const m = src.match(/https:\/\/player\.vimeo\.com\/video\/([0-9]+)/);
                    if (!m || m.length !== 2) {
                        return null;
                    }
                    return 'https://player.vimeo.com/video/' + m[1];
                }
            },
            {
                // ★ DOTS ESCAPED + fn REBUILDS A HARDCODED HOST (2026-09-04, security).
                // The old re had UNESCAPED dots (`www.youtube.com` — each `.` matched
                // any char, so `//www-youtube.com/embed/x` matched) and the fn only
                // stripped the query, returning the ATTACKER host verbatim: an author
                // could embed an iframe pointing at a registerable look-alike host for
                // phishing. Now only a real youtube embed id passes and the host is
                // rebuilt from a literal, exactly as vimeo/3speak already do.
                re: /^(?:https?:)?\/\/www\.youtube\.com\/embed\/[\w-]{11}(?:[/?#].*)?$/i,
                fn: (src: string) => {
                    if (!src) return null;
                    // Exactly an 11-char youtube id (or the literal `videoseries` for a
                    // playlist, also 11), captured with a hard boundary so no trailing
                    // attacker chars fold into the rebuilt path.
                    const m = src.match(/^(?:https?:)?\/\/www\.youtube\.com\/embed\/([\w-]{11})(?:[/?#]|$)/i);
                    if (!m) return null;
                    if (m[1].toLowerCase() === 'videoseries') {
                        const list = src.match(/[?&]list=([\w-]{10,40})(?:[&#]|$)/i);
                        return list ? `https://www.youtube.com/embed/videoseries?list=${list[1]}` : null;
                    }
                    return `https://www.youtube.com/embed/${m[1]}`;
                }
            },
            {
                // Dot escaped + the `url=` param VALIDATED to an api.soundcloud.com
                // resource (2026-09-04). The host was already hardcoded in fn, but the
                // old code embedded the raw attacker `url=` value; now only a real
                // soundcloud tracks/playlists/users resource may ride in the player.
                re: /^https:\/\/w\.soundcloud\.com\/player\/.*/i,
                fn: (src: string) => {
                    if (!src) {
                        return null;
                    }
                    const m = src.match(/[?&]url=([^&]+)/);
                    if (!m) {
                        return null;
                    }
                    let decoded: string;
                    try {
                        decoded = decodeURIComponent(m[1]);
                    } catch {
                        return null;
                    }
                    if (!/^https:\/\/api\.soundcloud\.com\/(tracks|playlists|users)\/\d{1,20}$/i.test(decoded)) {
                        return null;
                    }
                    return `https://w.soundcloud.com/player/?url=${encodeURIComponent(decoded)}&auto_play=false&hide_related=false&show_comments=true&show_user=true&show_reposts=false&visual=true`;
                }
            },
            {
                // ★ DOTS ESCAPED + params VALIDATED + host + parent HARDCODED (2026-09-04,
                // security). The old re had unescaped dots and the fn did `return src`
                // RAW, so `//player-twitch.tv/evil` rendered an attacker host. Now only
                // a validated channel/video/collection passes, the host is a literal,
                // and `parent` is OUR domain (never the src's — twitch requires parent
                // to match the embedding page, and an author-set one is a smell).
                re: /^(?:https?:)?\/\/player\.twitch\.tv\/\?.+/i,
                fn: (src: string) => {
                    if (!src) return null;
                    const q = src.match(/^(?:https?:)?\/\/player\.twitch\.tv\/\?(.+)$/i);
                    if (!q) return null;
                    const params = new URLSearchParams(q[1]);
                    const channel = params.get('channel');
                    const video = params.get('video');
                    const collection = params.get('collection');
                    let kind: string | null = null;
                    if (channel && /^[A-Za-z0-9_]{4,25}$/.test(channel)) kind = `channel=${channel}`;
                    else if (video && /^\d{1,20}$/.test(video)) kind = `video=${video}`;
                    else if (collection && /^[A-Za-z0-9]{1,64}$/.test(collection)) kind = `collection=${collection}`;
                    if (!kind) return null;
                    // parent MUST be our own host(s), never the src's. Both prod origins
                    // (Cloudflare serves apex + www) so a reader on either plays; twitch
                    // accepts multiple parent params. Non-prod origins won't play twitch
                    // (rare embed, acceptable) — never a security issue, just playback.
                    return `https://player.twitch.tv/?${kind}&parent=lumensocial.net&parent=www.lumensocial.net`;
                }
            },
            {
                // Path segment VALIDATED + host/path REBUILT (2026-09-04) instead of the
                // old `return src` raw. Host was already anchored+escaped (no phishing),
                // but the raw return kept the attacker's trailing path/query; now only a
                // base62 spotify id survives.
                re: /^https:\/\/open\.spotify\.com\/(embed|embed-podcast)\/(playlist|show|episode|album|track|artist)\/[A-Za-z0-9]{1,40}(?:[?#].*)?$/i,
                fn: (src: string) => {
                    const m = src.match(
                        /^https:\/\/open\.spotify\.com\/(embed|embed-podcast)\/(playlist|show|episode|album|track|artist)\/([A-Za-z0-9]{1,40})/i
                    );
                    return m ? `https://open.spotify.com/${m[1]}/${m[2]}/${m[3]}` : null;
                }
            },
            {
                // eslint-disable-next-line security/detect-unsafe-regex
                re: /^(?:https?:)?\/\/(?:3speak\.(?:tv|online|co))\/embed\?v=([^&\s]+)/i,
                fn: (src: string) => {
                    if (!src) return null;
                    const match = src.match(/3speak\.(?:tv|online|co)\/embed\?v=([^&\s]+)/i);
                    if (!match || match.length !== 2) return null;
                    return `https://3speak.tv/embed?v=${match[1]}`;
                }
            },
            {
                // eslint-disable-next-line security/detect-unsafe-regex
                re: /^(?:https?:)?\/\/(?:3speak\.(?:tv|online|co))\/watch\?v=([^&\s]+)/i,
                fn: (src: string) => {
                    if (!src) return null;
                    const match = src.match(/3speak\.(?:tv|online|co)\/watch\?v=([^&\s]+)/i);
                    if (!match || match.length !== 2) return null;
                    return `https://3speak.tv/embed?v=${match[1]}`;
                }
            },
            {
                re: /^(?:https:)\/\/(?:www\.)?(twitter|x)\.com\/(?:\w+\/status|status)\/(\d{1,20})/i,
                fn: (src: string) => {
                    if (!src) {
                        return null;
                    }
                    const match = src.match(/(?:twitter|x)\.com\/(?:\w+\/status|status)\/(\d{1,20})/i);
                    if (!match || match.length !== 2) {
                        return null;
                    }
                    return `https://platform.twitter.com/embed/Tweet.html?id=${match[1]}`;
                }
            }
        ],
        noImageText: '(Image not shown due to low ratings)',
        allowedTags: `
    div, iframe, del,
    a, p, b, i, q, br, ul, li, ol, img, h1, h2, h3, h4, h5, h6, hr,
    blockquote, pre, code, em, strong, center, table, thead, tbody, tr, th, td,
    strike, sup, sub, details, summary
`
            .trim()
            .split(/,\s*/)
    };
}
