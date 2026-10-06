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
 * - SkateHype, BitChute, Odysee, Skatehive IPFS videos, NFT Showroom, PeakD post
 *   embeds, Truvvl and youtube-nocookie players
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
                    // 2026-10-06: the protocol-relative `//player.vimeo.com` form was accepted
                    // by `re` but rejected here (this match demanded `https:`), so it rendered
                    // "(Unsupported ...)". And an unlisted video's `h=` privacy hash, which
                    // Vimeo's own embed code carries, was dropped, leaving a player that
                    // refuses the video. Both kept now, the host still a literal.
                    const m = src.match(/^(?:https?:)?\/\/player\.vimeo\.com\/video\/(\d{1,12})(?:[/?#]|$)/i);
                    if (!m) {
                        return null;
                    }
                    const h = src.match(/[?&]h=([0-9a-f]{6,20})(?:[&#]|$)/i);
                    return 'https://player.vimeo.com/video/' + m[1] + (h ? `?h=${h[1]}` : '');
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
                // 2026-10-06: a pasted single-video YouTube iframe no longer reaches this
                // entry in a normal render (HtmlDOMParser turns it into the facade first);
                // a playlist (`videoseries`) still does. Host widened to bare and `m.`
                // youtube.com, which rendered "(Unsupported ...)"; still rebuilt to www.
                re: /^(?:https?:)?\/\/(?:(?:www|m)\.)?youtube\.com\/embed\/[\w-]{11}(?:[/?#].*)?$/i,
                fn: (src: string) => {
                    if (!src) return null;
                    // Exactly an 11-char youtube id (or the literal `videoseries` for a
                    // playlist, also 11), captured with a hard boundary so no trailing
                    // attacker chars fold into the rebuilt path.
                    const m = src.match(/^(?:https?:)?\/\/(?:(?:www|m)\.)?youtube\.com\/embed\/([\w-]{11})(?:[/?#]|$)/i);
                    if (!m) return null;
                    if (m[1].toLowerCase() === 'videoseries') {
                        const list = src.match(/[?&]list=([\w-]{10,40})(?:[&#]|$)/i);
                        return list ? `https://www.youtube.com/embed/videoseries?list=${list[1]}` : null;
                    }
                    return `https://www.youtube.com/embed/${m[1]}`;
                }
            },
            {
                // Dot escaped + the `url=` param VALIDATED to a soundcloud resource
                // (2026-09-04). The host was already hardcoded in fn, but the old code
                // embedded the raw attacker `url=` value; now only a real soundcloud
                // resource may ride in the player, rebuilt from its validated parts.
                //
                // Widened 2026-10-06: the 09-04 check accepted only `api.soundcloud.com/
                // <kind>/<digits>` and blocked 11 real players on Lumen in 15 days. The
                // other forms SoundCloud itself emits are accepted too: the URN id its
                // current share code uses (`<kind>/soundcloud%3A<kind>%3A<digits>`), a
                // private track's `?secret_token=s-...`, and a plain soundcloud.com
                // permalink (`/<user>/<track>`, `/<user>/sets/<name>`).
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
                    let resource: string | null = null;
                    const api = decoded.match(/^https:\/\/api\.soundcloud\.com\/(tracks|playlists|users)\/(\d{1,20})(?:\?secret_token=(s-[A-Za-z0-9]{1,32}))?$/i);
                    const urn = decoded.match(/^https:\/\/api\.soundcloud\.com\/(tracks|playlists|users)\/soundcloud%3A(tracks|playlists|users)%3A(\d{1,20})$/i);
                    const permalink = decoded.match(/^https:\/\/(?:www\.|m\.)?soundcloud\.com\/([\w-]{1,100})\/([\w-]{1,200})(?:\/([\w-]{1,200}))?\/?$/i);
                    if (api) {
                        resource = `https://api.soundcloud.com/${api[1]}/${api[2]}` + (api[3] ? `?secret_token=${api[3]}` : '');
                    } else if (urn && urn[1].toLowerCase() === urn[2].toLowerCase()) {
                        resource = `https://api.soundcloud.com/${urn[1]}/soundcloud%3A${urn[2]}%3A${urn[3]}`;
                    } else if (permalink) {
                        resource = `https://soundcloud.com/${permalink[1]}/${permalink[2]}` + (permalink[3] ? `/${permalink[3]}` : '');
                    }
                    if (!resource) {
                        return null;
                    }
                    return `https://w.soundcloud.com/player/?url=${encodeURIComponent(resource)}&auto_play=false&hide_related=false&show_comments=true&show_user=true&show_reposts=false&visual=true`;
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
                // ★ THE EMITTED HOST IS `play.3speak.tv` — see ThreeSpeakEmbedder.processEmbed
                // for the measurement; `3speak.tv/embed` renders the SPA's "PAGE NOT FOUND".
                //
                // ★★ THE ACCEPTED-INPUT SIDE IS DELIBERATELY *NOT* WIDENED TO `play.`/`www.`
                // (2026-09-10, after the owner raised tibfox's "iframes by default are a
                // phishing gate"). It was, briefly, on the reasoning that `play.3speak.tv` is
                // the host `json_metadata.video.url` carries. It is — but this rule governs a
                // RAW `<iframe>` an author typed into a post body, and NO real 3speak post
                // uses one: the body is a bare URL (checked on @badadib/testvid-846 and
                // @daveks/bugaboo-falls-695), which reaches the page through
                // ThreeSpeakEmbedder, never through here. Widening it therefore bought
                // nothing and grew the raw-iframe surface, which is the exact surface the
                // concern is about. This stays as narrow as it was.
                re: /^(?:https?:)?\/\/(?:3speak\.(?:tv|online|co))\/embed\?v=([^&\s]+)/i,
                fn: (src: string) => {
                    if (!src) return null;
                    const match = src.match(/3speak\.(?:tv|online|co)\/embed\?v=([^&\s]+)/i);
                    if (!match || match.length !== 2) return null;
                    // `mode=iframe&layout=desktop`: 3speak's embed mode + strict 16:9 (see ThreeSpeakEmbedder.processEmbed).
                    return `https://play.3speak.tv/embed?v=${match[1]}&mode=iframe&layout=desktop`;
                }
            },
            {
                // eslint-disable-next-line security/detect-unsafe-regex
                re: /^(?:https?:)?\/\/(?:3speak\.(?:tv|online|co))\/watch\?v=([^&\s]+)/i,
                fn: (src: string) => {
                    if (!src) return null;
                    const match = src.match(/3speak\.(?:tv|online|co)\/watch\?v=([^&\s]+)/i);
                    if (!match || match.length !== 2) return null;
                    // `mode=iframe&layout=desktop`: 3speak's embed mode + strict 16:9 (see ThreeSpeakEmbedder.processEmbed).
                    return `https://play.3speak.tv/embed?v=${match[1]}&mode=iframe&layout=desktop`;
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
            },
            // ★ Players added 2026-10-06 from Lumen's own "Blocked iframe" log (09-21 to
            // 10-06: 250 distinct players blocked). Same rule as every entry above: the
            // `re` is anchored with escaped dots, and the fn re-validates the id with a
            // strict charset and REBUILDS the src from a hardcoded host, so nothing an
            // author writes beyond the validated id reaches the page. Each host was
            // checked to allow framing (no X-Frame-Options / frame-ancestors).
            {
                // SkateHype's auto-posts (146 distinct videos blocked in 15 days).
                re: /^(?:https?:)?\/\/(?:www\.)?skatehype\.com\/ifplay\.php\?v=\d{1,10}(?:[&#].*)?$/i,
                fn: (src: string) => {
                    const m = src.match(/^(?:https?:)?\/\/(?:www\.)?skatehype\.com\/ifplay\.php\?v=(\d{1,10})(?:[&#]|$)/i);
                    return m ? `https://www.skatehype.com/ifplay.php?v=${m[1]}` : null;
                }
            },
            {
                // A pasted BitChute player. Bare bitchute.com/video/ links go through BitChuteEmbedder.
                re: /^(?:https?:)?\/\/(?:(?:www|old)\.)?bitchute\.com\/embed\/[\w-]{6,32}\/?(?:[?#].*)?$/i,
                fn: (src: string) => {
                    const m = src.match(/^(?:https?:)?\/\/(?:(?:www|old)\.)?bitchute\.com\/embed\/([\w-]{6,32})(?:[/?#]|$)/i);
                    return m ? `https://www.bitchute.com/embed/${m[1]}/` : null;
                }
            },
            {
                // Odysee writes the path both plain (`$/embed/...`) and percent-encoded
                // (`%24/embed/%40chan%3A6%2Fname%3A1`), so it is decoded before matching.
                // Two shapes: `<name>/<40-hex claim id>` and `@<channel>:<id>/<name>:<id>`.
                // No dots in names, so the rebuilt path can never contain `..`.
                re: /^https:\/\/odysee\.com\/(?:\$|%24)\/embed\//i,
                fn: (src: string) => {
                    const m = src.match(/^https:\/\/odysee\.com\/([^?#]+)/i);
                    if (!m) return null;
                    let path: string;
                    try {
                        path = decodeURIComponent(m[1]);
                    } catch {
                        return null;
                    }
                    const p = path.match(/^\$\/embed\/((?:@[\w-]{1,100}:[0-9a-f]{1,40}\/[\w-]{1,200}:[0-9a-f]{1,40})|(?:[\w-]{1,200}\/[0-9a-f]{40}))$/i);
                    return p ? `https://odysee.com/$/embed/${p[1]}` : null;
                }
            },
            {
                // Skatehive's IPFS gateway serves the video file itself. A
                // `pinataGatewayToken` some posts carry is dropped: the gateway serves
                // without it (measured 2026-10-06), and it is someone's credential.
                re: /^https:\/\/ipfs\.skatehive\.app\/ipfs\/(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,100})(?:[?#].*)?$/,
                fn: (src: string) => {
                    const m = src.match(/^https:\/\/ipfs\.skatehive\.app\/ipfs\/(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,100})(?:[?#]|$)/);
                    return m ? `https://ipfs.skatehive.app/ipfs/${m[1]}` : null;
                }
            },
            {
                re: /^https:\/\/nftshowroom\.com\/embed\/[\w-]{1,200}\/?(?:[?#].*)?$/i,
                fn: (src: string) => {
                    const m = src.match(/^https:\/\/nftshowroom\.com\/embed\/([\w-]{1,200})(?:[/?#]|$)/i);
                    return m ? `https://nftshowroom.com/embed/${m[1]}` : null;
                }
            },
            {
                // PeakD's post embed: `[<community or tag>/]@<account>/<permlink>`.
                re: /^https:\/\/embed\.peakd\.com\/(?:[\w-]{1,50}\/)?@[a-z0-9.-]{3,16}\/[a-z0-9-]{1,255}\/?(?:[?#].*)?$/i,
                fn: (src: string) => {
                    const m = src.match(/^https:\/\/embed\.peakd\.com\/(?:([\w-]{1,50})\/)?@([a-z0-9.-]{3,16})\/([a-z0-9-]{1,255})(?:[/?#]|$)/i);
                    return m ? `https://embed.peakd.com/${m[1] ? `${m[1]}/` : ''}@${m[2]}/${m[3]}` : null;
                }
            },
            // Aureal (aureal-embed.web.app) was added 2026-10-06 and removed the same day: its
            // player renders but cannot play, because Aureal's own API (api.aureal.one)
            // serves an invalid TLS certificate (measured, also outside Lumen). A dead
            // player is worse than the plain "(Unsupported ...)" line, so it stays blocked
            // with the other dead hosts until that changes.
            {
                re: /^https:\/\/embed\.truvvl\.com\/@[a-z0-9.-]{3,16}\/[a-z0-9-]{1,255}\/?(?:[?#].*)?$/i,
                fn: (src: string) => {
                    const m = src.match(/^https:\/\/embed\.truvvl\.com\/@([a-z0-9.-]{3,16})\/([a-z0-9-]{1,255})(?:[/?#]|$)/i);
                    return m ? `https://embed.truvvl.com/@${m[1]}/${m[2]}` : null;
                }
            },
            {
                // A pasted Rumble player. `pub` is the publisher's revenue id from Rumble's
                // own embed code, kept when it is plain alphanumerics. Bare rumble.com links
                // go through RumbleEmbedder. Added 2026-10-06.
                re: /^(?:https?:)?\/\/(?:www\.)?rumble\.com\/embed\/[a-z0-9]{4,20}\/?(?:[?#].*)?$/i,
                fn: (src: string) => {
                    const m = src.match(/^(?:https?:)?\/\/(?:www\.)?rumble\.com\/embed\/([a-z0-9]{4,20})(?:[/?#]|$)/i);
                    if (!m) return null;
                    const pub = src.match(/[?&]pub=([a-z0-9]{1,20})(?:[&#]|$)/i);
                    return `https://rumble.com/embed/${m[1]}/` + (pub ? `?pub=${pub[1]}` : '');
                }
            },
            {
                // YouTube's privacy-enhanced player. Kept on youtube-nocookie, the author's choice.
                re: /^(?:https?:)?\/\/www\.youtube-nocookie\.com\/embed\/[\w-]{11}(?:[/?#].*)?$/i,
                fn: (src: string) => {
                    const m = src.match(/^(?:https?:)?\/\/www\.youtube-nocookie\.com\/embed\/([\w-]{11})(?:[/?#]|$)/i);
                    return m ? `https://www.youtube-nocookie.com/embed/${m[1]}` : null;
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
