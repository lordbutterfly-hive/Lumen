/**
 * IFRAME ALLOWLIST SECURITY (2026-09-04). Runs author-supplied raw <iframe> and
 * bare embed URLs through the FULL renderer and asserts: (a) valid embeds render
 * with a HARDCODED host + a sandbox that omits top-navigation/popups; (b) every
 * attacker vector (look-alike host, userinfo, suffix, substring, scheme, raw src)
 * is BLOCKED (rendered as the "(Unsupported ...)" placeholder, never as an iframe
 * pointing at an attacker host). Regression guard for the phishing bypasses found
 * in the youtube/twitch entries + the soundcloud/spotify param tightening.
 */
import {expect} from 'chai';
import 'mocha';
import {DefaultRenderer, RendererOptions} from './DefaultRenderer';

function makeRenderer(): DefaultRenderer {
    const options: RendererOptions = {
        baseUrl: 'https://lumensocial.net/',
        breaks: true,
        skipSanitization: false,
        allowInsecureScriptTags: false,
        addNofollowToLinks: true,
        addTargetBlankToLinks: true,
        cssClassForInternalLinks: 'internal',
        cssClassForExternalLinks: 'external',
        doNotShowImages: false,
        ipfsPrefix: 'https://ipfs.io/ipfs/',
        assetsWidth: 640,
        assetsHeight: 480,
        imageProxyFn: (url: string) => url,
        hashtagUrlFn: (hashtag: string) => `/trending/${hashtag}`,
        usertagUrlFn: (account: string) => `/@${account}`,
        isLinkSafeFn: () => true,
        addExternalCssClassToMatchingLinksFn: () => true
    };
    return new DefaultRenderer(options);
}

/** Every rendered iframe src, lowercased host-relevant. */
function iframeSrcs(html: string): string[] {
    const out: string[] = [];
    const re = /<iframe[^>]*\ssrc="([^"]*)"/gi;
    let m;
    while ((m = re.exec(html)) !== null) out.push(m[1]);
    return out;
}

describe('iframe allowlist security', function () {
    let r: DefaultRenderer;
    beforeEach(() => {
        r = makeRenderer();
    });

    const blocked = (src: string): void => {
        const html = r.render(`<iframe src="${src}"></iframe>`);
        const srcs = iframeSrcs(html);
        expect(srcs, `expected NO iframe for blocked src ${src}, got ${JSON.stringify(srcs)}`).to.have.length(0);
    };

    /** The facade ids on a page (a pasted YouTube iframe renders as the facade since 2026-10-06). */
    const facadeIds = (html: string): string[] => [...html.matchAll(/data-youtube-id="([^"]*)"/g)].map((m) => m[1]);

    describe('YouTube', () => {
        it('renders a pasted single-video iframe as the facade, with no server-rendered iframe', () => {
            const html = r.render('<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1"></iframe>');
            expect(iframeSrcs(html)).to.deep.equal([]);
            expect(facadeIds(html)).to.deep.equal(['dQw4w9WgXcQ']);
        });
        it('renders bare, m. and protocol-relative youtube.com/embed iframes as the facade', () => {
            for (const src of ['https://youtube.com/embed/dQw4w9WgXcQ', 'https://m.youtube.com/embed/dQw4w9WgXcQ', '//www.youtube.com/embed/dQw4w9WgXcQ?start=30']) {
                const html = r.render(`<iframe src="${src}"></iframe>`);
                expect(facadeIds(html), src).to.deep.equal(['dQw4w9WgXcQ']);
                expect(html, src).to.not.contain('Unsupported');
            }
        });
        it('keeps a playlist (videoseries) as a sandboxed iframe, the facade has no playlist form', () => {
            const html = r.render('<iframe src="https://www.youtube.com/embed/videoseries?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI"></iframe>');
            expect(iframeSrcs(html).map((s) => s.replace(/&amp;/g, '&'))).to.deep.equal([
                'https://www.youtube.com/embed/videoseries?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI'
            ]);
            expect(facadeIds(html)).to.deep.equal([]);
        });
        it('BLOCKS the look-alike host (unescaped-dot bypass)', () => blocked('//www-youtube.com/embed/dQw4w9WgXcQ'));
        it('BLOCKS a subdomain-suffix host', () => blocked('https://www.youtube.com.evil.com/embed/dQw4w9WgXcQ'));
        it('BLOCKS a userinfo host', () => blocked('https://www.youtube.com@evil.com/embed/dQw4w9WgXcQ'));
        it('strips a trailing path after a valid id (garbage not folded into the facade id)', () => {
            const html = r.render('<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ/../../evil"></iframe>');
            expect(facadeIds(html)).to.deep.equal(['dQw4w9WgXcQ']);
            expect(iframeSrcs(html)).to.deep.equal([]);
        });
        it('BLOCKS a 12-char id (wrong length, no boundary)', () => blocked('https://www.youtube.com/embed/dQw4w9WgXcQX'));
        it('never puts a hostile character into a facade id', () => {
            for (const src of ['https://www.youtube.com/embed/dQw4w9WgXc"', 'https://www.youtube.com/embed/dQw4w9W"onx=1', 'https://www.youtube.com/embed/<script>abc']) {
                for (const id of facadeIds(r.render(`<iframe src='${src}'></iframe>`))) expect(id, src).to.match(/^[A-Za-z0-9_-]{11}$/);
            }
        });
    });

    describe('YouTube bare links (2026-10-06 shapes)', () => {
        const ok: Array<[string, string]> = [
            ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
            ['https://music.youtube.com/watch?v=dQw4w9WgXcQ&si=abc', 'dQw4w9WgXcQ'],
            ['https://www.youtube.com/live/dQw4w9WgXcQ?si=abc', 'dQw4w9WgXcQ'],
            ['https://www.youtube.com/watch?feature=share&v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
            ['https://www.youtube.com/watch?app=desktop&feature=x&v=dQw4w9WgXcQ&t=42s', 'dQw4w9WgXcQ'],
            ['https://youtu.be/dQw4w9WgXcQ?si=AbCdEf123', 'dQw4w9WgXcQ'],
            ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ']
        ];
        for (const [link, id] of ok) {
            it(`renders ${link} as the facade`, () => expect(facadeIds(r.render(link))).to.deep.equal([id]));
        }
        it('does NOT embed a look-alike host or a too-long id', () => {
            const links = [
                'https://m-youtube.com/watch?v=dQw4w9WgXcQ',
                'https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ',
                'https://www.youtube.com/watch?v=dQw4w9WgXcQX'
            ];
            for (const link of links) {
                expect(facadeIds(r.render(link)), link).to.deep.equal([]);
            }
        });
    });

    describe('Vimeo (2026-10-06 shapes)', () => {
        it('renders www., channels/ and groups/ links as the player', () => {
            const links = ['https://www.vimeo.com/76979871', 'https://vimeo.com/channels/staffpicks/76979871', 'https://vimeo.com/groups/shortfilms/videos/76979871'];
            for (const link of links) {
                expect(iframeSrcs(r.render(link)), link).to.deep.equal(['https://player.vimeo.com/video/76979871']);
            }
        });
        it('keeps an unlisted video hash, from a share link and from a pasted player', () => {
            expect(iframeSrcs(r.render('https://vimeo.com/76979871/abc123def4'))).to.deep.equal(['https://player.vimeo.com/video/76979871?h=abc123def4']);
            const pasted = iframeSrcs(r.render('<iframe src="https://player.vimeo.com/video/76979871?h=abc123def4&badge=0"></iframe>'));
            expect(pasted).to.deep.equal(['https://player.vimeo.com/video/76979871?h=abc123def4']);
        });
        it('renders a protocol-relative pasted player (was Unsupported)', () => {
            const html = r.render('<iframe src="//player.vimeo.com/video/76979871"></iframe>');
            expect(iframeSrcs(html)).to.deep.equal(['https://player.vimeo.com/video/76979871']);
        });
        it('never carries a non-hex hash or a hostile character', () => {
            for (const src of ['https://player.vimeo.com/video/76979871?h=zz"onload', 'https://player.vimeo.com/video/76979871?h=abc123def4"><script>']) {
                for (const s of iframeSrcs(r.render(`<iframe src='${src}'></iframe>`))) {
                    expect(s, src).to.match(/^https:\/\/player\.vimeo\.com\/video\/76979871(\?h=[0-9a-f]{6,20})?$/);
                }
            }
            expect(iframeSrcs(r.render('https://vimeo.com/76979871/notahash1'))).to.deep.equal(['https://player.vimeo.com/video/76979871']);
        });
    });

    describe('Rumble (2026-10-06)', () => {
        it('renders a pasted player rebuilt to rumble.com, keeping a plain pub id', () => {
            const html = r.render('<iframe src="https://rumble.com/embed/v2zd1v6/?pub=1gjaba&x=1"></iframe>');
            expect(iframeSrcs(html).map((s) => s.replace(/&amp;/g, '&'))).to.deep.equal(['https://rumble.com/embed/v2zd1v6/?pub=1gjaba']);
        });
        it('renders a bare player link as the player', () => {
            expect(iframeSrcs(r.render('https://rumble.com/embed/v2zd1v6/?pub=1gjaba'))).to.deep.equal(['https://rumble.com/embed/v2zd1v6/?pub=1gjaba']);
        });
        it('renders a bare page link as a facade + plain link (the player id needs a lookup)', () => {
            const html = r.render('Watch https://rumble.com/v6ur90f-i-am-cat-muti-player-quest-3-headset.html?e9s=src_v1 now');
            expect(iframeSrcs(html)).to.deep.equal([]);
            expect(html).to.contain('data-rumble-page="v6ur90f-i-am-cat-muti-player-quest-3-headset"');
            expect(html).to.contain('href="https://rumble.com/v6ur90f-i-am-cat-muti-player-quest-3-headset.html"');
        });
        it('BLOCKS look-alike hosts and hostile ids', () => {
            const hostile = [
                'https://rumble.com.evil.com/embed/v2zd1v6/',
                'https://rumble.com@evil.com/embed/v2zd1v6/',
                'https://evil-rumble.com/embed/v2zd1v6/',
                'https://rumble.com/embed/v2"onload=x/'
            ];
            for (const src of hostile) {
                for (const s of iframeSrcs(r.render(`<iframe src='${src}'></iframe>`))) {
                    expect(s, src).to.match(/^https:\/\/rumble\.com\/embed\/[a-z0-9]{4,20}\/(\?pub=[a-z0-9]{1,20})?$/i);
                }
                expect(r.render(src), src).to.not.contain('rumble-facade');
            }
        });
        it('a hand-typed marker with a hostile id renders nothing', () => {
            const html = r.render('~~~ embed:p-v6ur90f-a"onmouseover=x rumble ~~~ and ~~~ embed:e-../evil rumble ~~~');
            expect(html).to.not.contain('rumble-facade');
            expect(iframeSrcs(html)).to.deep.equal([]);
        });
    });

    describe('Twitch', () => {
        it('renders a valid channel with OUR parent, dropping the src parent', () => {
            const html = r.render('<iframe src="https://player.twitch.tv/?channel=ninja&parent=evil.com"></iframe>');
            const src = iframeSrcs(html)[0] || '';
            const decoded = src.replace(/&amp;/g, '&');
            expect(decoded).to.equal('https://player.twitch.tv/?channel=ninja&parent=lumensocial.net&parent=www.lumensocial.net');
            expect(decoded).to.not.contain('evil.com');
        });
        it('BLOCKS the look-alike host (was return src raw)', () => blocked('//player-twitch.tv/evil'));
        it('BLOCKS a bad channel charset', () => blocked('https://player.twitch.tv/?channel=a"><script>'));
    });

    describe('SoundCloud', () => {
        it('renders a valid api.soundcloud.com track', () => {
            const src = 'https://w.soundcloud.com/player/?url=https%3A%2F%2Fapi.soundcloud.com%2Ftracks%2F257659076&auto_play=false';
            const html = r.render(`<iframe src="${src}"></iframe>`);
            expect(iframeSrcs(html)[0]).to.match(/^https:\/\/w\.soundcloud\.com\/player\/\?url=https%3A%2F%2Fapi\.soundcloud\.com%2Ftracks%2F257659076/);
        });
        it('BLOCKS a non-soundcloud url param', () => blocked('https://w.soundcloud.com/player/?url=https%3A%2F%2Fevil.com%2Fx&auto_play=false'));

        // The three forms below were BLOCKED by the 09-04 check; each input is a real
        // src from Lumen's "Blocked iframe" log (09-21 to 10-06).
        const decodedUrl = (html: string): string => {
            const src = (iframeSrcs(html)[0] || '').replace(/&amp;/g, '&');
            const m = src.match(/^https:\/\/w\.soundcloud\.com\/player\/\?url=([^&]+)&/);
            return m ? decodeURIComponent(m[1]) : `(no soundcloud player: ${src})`;
        };
        it('renders the URN id form of SoundCloud share code, unchanged', () => {
            const src =
                'https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/playlists/soundcloud%253Aplaylists%253A2110977434&color=%23040404&auto_play=true&hide_related=false';
            expect(decodedUrl(r.render(`<iframe src="${src}"></iframe>`))).to.equal('https://api.soundcloud.com/playlists/soundcloud%3Aplaylists%3A2110977434');
        });
        it('renders a private track with its secret token', () => {
            const src = 'https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/tracks/128779094%3Fsecret_token%3Ds-VzBvf&color=%23ff5500&auto_play=false';
            expect(decodedUrl(r.render(`<iframe src="${src}"></iframe>`))).to.equal('https://api.soundcloud.com/tracks/128779094?secret_token=s-VzBvf');
        });
        it('renders a plain soundcloud.com permalink', () => {
            const src = 'https://w.soundcloud.com/player/?url=https%3A//soundcloud.com/thylacinew/piany-pianino&auto_play=false&hide_related=false';
            expect(decodedUrl(r.render(`<iframe src="${src}"></iframe>`))).to.equal('https://soundcloud.com/thylacinew/piany-pianino');
        });
        it('never autoplays, even when the author asked for it', () => {
            const src = 'https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/tracks/soundcloud%253Atracks%253A2367631499&auto_play=true';
            const out = (iframeSrcs(r.render(`<iframe src="${src}"></iframe>`))[0] || '').replace(/&amp;/g, '&');
            expect(out).to.contain('auto_play=false');
            expect(out).to.not.contain('auto_play=true');
        });
        const hostileSoundCloud = [
            'https://w.soundcloud.com/player/?url=https%3A//soundcloud.com.evil.com/a/b',
            'https://w.soundcloud.com/player/?url=https%3A//soundcloud.com@evil.com/a/b',
            'https://w.soundcloud.com/player/?url=https%3A//evil.com/soundcloud.com/a/b',
            'https://w.soundcloud.com/player/?url=https%3A//soundcloud.com/a/b/c/d',
            'https://w.soundcloud.com/player/?url=https%3A//soundcloud.com/a/..%252F..%252Fevil',
            'https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/tracks/1%3Fsecret_token%3Ds-x%2526evil%253D1',
            'https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/tracks/soundcloud%253Aplaylists%253A1',
            'https://w.soundcloud.com/player/?url=javascript:alert(1)'
        ];
        for (const src of hostileSoundCloud) {
            it(`BLOCKS ${src}`, () => blocked(src));
        }
    });

    /**
     * ★ PLAYERS ADDED 2026-10-06. Each valid input is a real src from Lumen's
     * "Blocked iframe" log or a real post; each must rebuild to exactly the
     * expected src. Then every hostile variant of every host must leave no iframe
     * pointing anywhere but the real hosts.
     */
    describe('players added 2026-10-06', () => {
        const valid: Array<[string, string]> = [
            ['https://www.skatehype.com/ifplay.php?v=35202', 'https://www.skatehype.com/ifplay.php?v=35202'],
            ['//skatehype.com/ifplay.php?v=35202&autoplay=1', 'https://www.skatehype.com/ifplay.php?v=35202'],
            ['https://www.bitchute.com/embed/Ap7lxto3Hl7X/', 'https://www.bitchute.com/embed/Ap7lxto3Hl7X/'],
            ['https://old.bitchute.com/embed/Ap7lxto3Hl7X', 'https://www.bitchute.com/embed/Ap7lxto3Hl7X/'],
            [
                'https://odysee.com/$/embed/2021-12-12-00-12-27/d5a15676ab9d66c16ce850c2b4d1c24f2ed7f3c6?r=BaCwYAN2K9zLKf1R25N9Av64xcZiASPC',
                'https://odysee.com/$/embed/2021-12-12-00-12-27/d5a15676ab9d66c16ce850c2b4d1c24f2ed7f3c6'
            ],
            [
                'https://odysee.com/$/embed/@SmaragdisRubor:3/sneak:44?r=AvrrBitehAHvACDTSZqeyFTf7xX9qEYj&autoplay=true',
                'https://odysee.com/$/embed/@SmaragdisRubor:3/sneak:44'
            ],
            [
                'https://odysee.com/%24/embed/%40criptomonedastv%3A6%2FHBC-Septiembre-23-2026%3A1?r=FUDCGuukwy6i6mWNNcrXHPqCUjaLLeNp',
                'https://odysee.com/$/embed/@criptomonedastv:6/HBC-Septiembre-23-2026:1'
            ],
            [
                'https://ipfs.skatehive.app/ipfs/QmPdsChTSXQkqu3FLJHcAjqdLCqq5bCcnC1dKwCB8oLA1S?pinataGatewayToken=nxHSFa1jQsiF7IHeXWH',
                'https://ipfs.skatehive.app/ipfs/QmPdsChTSXQkqu3FLJHcAjqdLCqq5bCcnC1dKwCB8oLA1S'
            ],
            [
                'https://ipfs.skatehive.app/ipfs/bafybeihmjw3sgcopgwvmnzlq3cskld3dokp55yleaz3carsltp4zqdh4em',
                'https://ipfs.skatehive.app/ipfs/bafybeihmjw3sgcopgwvmnzlq3cskld3dokp55yleaz3carsltp4zqdh4em'
            ],
            ['https://nftshowroom.com/embed/undersound_come-musica_quincy-jones', 'https://nftshowroom.com/embed/undersound_come-musica_quincy-jones'],
            ['https://embed.peakd.com/hive-139531/@asgarth/re-fjworld-tjm20x', 'https://embed.peakd.com/hive-139531/@asgarth/re-fjworld-tjm20x'],
            ['https://embed.peakd.com/@asgarth/re-fjworld-tjm20x', 'https://embed.peakd.com/@asgarth/re-fjworld-tjm20x'],
            [
                'https://embed.truvvl.com/@borivan/firemens-saves-our-live-respect-firemen-20211124t133726812z',
                'https://embed.truvvl.com/@borivan/firemens-saves-our-live-respect-firemen-20211124t133726812z'
            ],
            ['https://www.youtube-nocookie.com/embed/hME4bzrPkGk?start=10', 'https://www.youtube-nocookie.com/embed/hME4bzrPkGk']
        ];
        for (const [input, expected] of valid) {
            it(`renders ${input}`, () => {
                const srcs = iframeSrcs(r.render(`<iframe src="${input}"></iframe>`)).map((s) => s.replace(/&amp;/g, '&'));
                expect(srcs).to.deep.equal([expected]);
            });
        }

        it('renders the real skatehype post body (@miguelurbina) as a sandboxed player', () => {
            const body =
                "<div style='position:relative;padding-bottom:56.25%;height:0;overflow:hidden'><iframe style='position:absolute;top:0;left:0;width:100%;height:100%' allowfullscreen src='https://www.skatehype.com/ifplay.php?v=35202' name='hype35202'></iframe><br>\n</div>";
            const html = r.render(body);
            expect(iframeSrcs(html)).to.deep.equal(['https://www.skatehype.com/ifplay.php?v=35202']);
            expect(html).to.match(/<iframe[^>]*\ssandbox="allow-scripts allow-same-origin allow-presentation"/);
            expect(html).to.not.contain('Unsupported');
        });

        const realHosts =
            /^https:\/\/(?:www\.skatehype\.com|www\.bitchute\.com|odysee\.com|ipfs\.skatehive\.app|nftshowroom\.com|embed\.peakd\.com|embed\.truvvl\.com|www\.youtube-nocookie\.com)\//;
        const hostile = [
            'https://www.skatehype.com.evil.com/ifplay.php?v=1',
            'https://www.skatehype.com@evil.com/ifplay.php?v=1',
            'https://evil.com/www.skatehype.com/ifplay.php?v=1',
            'https://www-skatehype.com/ifplay.php?v=1',
            'https://www.skatehype.com/ifplay.php?v=1"><iframe src="https://evil.com"></iframe>',
            'https://www.skatehype.com/ifplay.php?v=1x',
            'https://www.bitchute.com.evil.com/embed/Ap7lxto3Hl7X/',
            'https://bitchute.com@evil.com/embed/Ap7lxto3Hl7X/',
            'https://www.bitchute.com/embed/Ap7lxto3Hl7X/../../evil',
            'https://www.bitchute.com/embed/a"onload="x/',
            'https://odysee.com.evil.com/$/embed/name/d5a15676ab9d66c16ce850c2b4d1c24f2ed7f3c6',
            'https://odysee.com@evil.com/$/embed/name/d5a15676ab9d66c16ce850c2b4d1c24f2ed7f3c6',
            'https://odysee.com/$/embed/../d5a15676ab9d66c16ce850c2b4d1c24f2ed7f3c6',
            'https://odysee.com/%24/embed/..%2F..%2Fevil/d5a15676ab9d66c16ce850c2b4d1c24f2ed7f3c6',
            'https://odysee.com/$/embed/name/d5a15676ab9d66c16ce850c2b4d1c24f2ed7f3c6/extra',
            'https://odysee.com/%24/embed/%40x%3A1%2Fy%3A1%22%3E%3Cscript%3E',
            'https://ipfs.skatehive.app.evil.com/ipfs/QmPdsChTSXQkqu3FLJHcAjqdLCqq5bCcnC1dKwCB8oLA1S',
            'https://ipfs.skatehive.app/ipfs/QmPdsChTSXQkqu3FLJHcAjqdLCqq5bCcnC1dKwCB8oLA1S/../../evil',
            'https://ipfs.skatehive.app/ipns/evil.com',
            'http://ipfs.skatehive.app/ipfs/QmPdsChTSXQkqu3FLJHcAjqdLCqq5bCcnC1dKwCB8oLA1S',
            'https://nftshowroom.com.evil.com/embed/x',
            'https://nftshowroom.com/embed/x/../../evil',
            'https://embed.peakd.com.evil.com/@a/b',
            'https://embed.peakd.com/@asgarth/../../evil',
            'https://embed.peakd.com/../@asgarth/x',
            'https://aureal-embed.web.app.evil.com/1',
            'https://aureal-embed-web.app/1',
            'https://embed.truvvl.com.evil.com/@a/b',
            'https://www.youtube-nocookie.com.evil.com/embed/hME4bzrPkGk',
            'https://www-youtube-nocookie.com/embed/hME4bzrPkGk',
            'javascript:alert(1)//www.skatehype.com/ifplay.php?v=1'
        ];
        for (const input of hostile) {
            it(`never points an iframe at a non-allowlisted host for: ${input}`, () => {
                for (const wrapped of [input, `<iframe src="${input}"></iframe>`]) {
                    for (const src of iframeSrcs(r.render(wrapped))) {
                        const safe = realHosts.test(src) && !src.includes('..') && !src.includes('"');
                        expect(safe, `rendered iframe escaped the allowlist: ${src} (from ${wrapped})`).to.equal(true);
                    }
                }
            });
        }
    });

    describe('BitChute bare links', () => {
        it('renders a bare bitchute.com/video link as the bitchute player', () => {
            const srcs = iframeSrcs(r.render('Watch this https://www.bitchute.com/video/Ap7lxto3Hl7X/ now'));
            expect(srcs).to.deep.equal(['https://www.bitchute.com/embed/Ap7lxto3Hl7X/']);
        });
        it('the bitchute player carries the sandbox', () => {
            const html = r.render('https://www.bitchute.com/video/Ap7lxto3Hl7X/');
            expect(html).to.match(/<iframe[^>]*\ssandbox="allow-scripts allow-same-origin allow-presentation"/);
        });
        it('does NOT embed a bitchute look-alike', () => {
            expect(iframeSrcs(r.render('https://www.bitchute.com.evil.com/video/Ap7lxto3Hl7X/'))).to.have.length(0);
            expect(iframeSrcs(r.render('https://evilbitchute.com/video/Ap7lxto3Hl7X/'))).to.have.length(0);
        });
    });

    describe('X mirror links', () => {
        it('renders the goyimx.com link through the X player by tweet id', () => {
            const srcs = iframeSrcs(r.render('https://goyimx.com/Thefactsdude/status/2103488248148320301#m'));
            expect(srcs).to.deep.equal(['https://platform.twitter.com/embed/Tweet.html?id=2103488248148320301']);
        });
        it('renders nitter / xcancel / fxtwitter / mobile.x.com links the same way', () => {
            for (const host of ['nitter.net', 'xcancel.com', 'fxtwitter.com', 'mobile.x.com']) {
                const srcs = iframeSrcs(r.render(`https://${host}/someone/status/2103488248148320301`));
                expect(srcs, host).to.deep.equal(['https://platform.twitter.com/embed/Tweet.html?id=2103488248148320301']);
            }
        });
        it('does NOT embed a non-mirror host that merely ends in a mirror name', () => {
            expect(iframeSrcs(r.render('https://evilgoyimx.com/a/status/2103488248148320301'))).to.have.length(0);
            expect(iframeSrcs(r.render('https://goyimx.com.evil.com/a/status/2103488248148320301'))).to.have.length(0);
        });
    });

    describe('Spotify', () => {
        it('renders a valid track, dropping trailing attacker path', () => {
            const html = r.render('<iframe src="https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT?extra=x/../evil"></iframe>');
            expect(iframeSrcs(html)).to.deep.equal(['https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT']);
        });
        it('BLOCKS a suffix host', () => blocked('https://open.spotify.com.evil.com/embed/track/4cOdK2wGLETKBW3PvgPWqT'));
    });

    describe('Vimeo', () => {
        it('renders a valid video', () => {
            const html = r.render('<iframe src="https://player.vimeo.com/video/179213493"></iframe>');
            expect(iframeSrcs(html)).to.deep.equal(['https://player.vimeo.com/video/179213493']);
        });
        it('BLOCKS a look-alike host', () => blocked('https://player-vimeo.com/video/179213493'));
    });

    describe('3speak', () => {
        it('renders a bare play.3speak.tv embed URL, rebuilt to the play.3speak.tv host', () => {
            const html = r.render('https://play.3speak.tv/embed?v=badadib/g9sgdk5h');
            expect(iframeSrcs(html)).to.deep.equal(['https://play.3speak.tv/embed?v=badadib/g9sgdk5h&mode=iframe&layout=desktop']);
        });
        it('does NOT embed 3speak when the url is only a substring of another link', () => {
            const html = r.render('<a href="https://evil.com/?x=3speak.tv/watch?v=a/b">x</a>');
            expect(iframeSrcs(html)).to.have.length(0);
        });

        /**
         * ★★★ THE HOST CHANGE MUST NOT HAVE OPENED A DOOR (2026-09-10). The emitted
         * host moved from `3speak.tv` to `play.3speak.tv`, and every one of these is a
         * way an author could try to make the new subdomain form resolve to THEIR
         * server instead. The property under test is the one that makes the whole
         * allowlist a real defence rather than a filter: NO src an author writes is
         * ever echoed back -- a match rebuilds the URL from a hardcoded literal, and a
         * non-match renders no iframe at all. So the assertion is not "these are
         * rejected", it is "no iframe on this page points anywhere but at a 3speak
         * host", which stays true even for inputs that DO match.
         */
        const hostileThreeSpeak = [
            'https://play.3speak.tv.evil.com/embed?v=a/b',
            'https://play.3speak.tv@evil.com/embed?v=a/b',
            'https://evil.com/play.3speak.tv/embed?v=a/b',
            'https://play-3speak.tv/embed?v=a/b',
            'https://playx3speak.tv/embed?v=a/b',
            'https://www.3speak.tv.evil.com/watch?v=a/b',
            'javascript:alert(1)//play.3speak.tv/embed?v=a/b',
            'https://play.3speak.tv/embed?v=a/b"><iframe src="https://evil.com"></iframe>',
            'https://play.3speak.tv/embed?v=a/b#https://evil.com/embed?v=c/d'
        ];
        for (const input of hostileThreeSpeak) {
            it(`never points an iframe at a non-3speak host for: ${input}`, () => {
                for (const wrapped of [input, `<iframe src="${input}"></iframe>`]) {
                    const srcs = iframeSrcs(r.render(wrapped));
                    for (const src of srcs) {
                        expect(
                            /^https:\/\/(?:play\.)?3speak\.tv\//.test(src),
                            `rendered iframe escaped the allowlist: ${src} (from ${wrapped})`
                        ).to.equal(true);
                    }
                }
            });
        }
    });

    describe('sandbox', () => {
        it('every rendered embed carries a sandbox WITHOUT top-navigation or popups', () => {
            // A pasted Vimeo player: the raw-iframe (sanitizer) path. A pasted YouTube one
            // no longer takes this path, it becomes the facade (2026-10-06).
            const html = r.render('<iframe src="https://player.vimeo.com/video/76979871"></iframe>');
            const m = html.match(/<iframe[^>]*\ssandbox="([^"]*)"/i);
            expect(m, 'iframe must have a sandbox attribute').to.not.equal(null);
            const sb = (m as RegExpMatchArray)[1];
            expect(sb).to.contain('allow-scripts');
            expect(sb).to.contain('allow-same-origin');
            expect(sb).to.not.contain('allow-top-navigation');
            expect(sb).to.not.contain('allow-popups');
        });
        it('a bare Rumble player link (embedder path) carries the sandbox', () => {
            const html = r.render('https://rumble.com/embed/v2zd1v6/');
            expect(html).to.match(/<iframe[^>]*\ssandbox="allow-scripts allow-same-origin allow-presentation"/);
        });
        it('an EMBEDDER-generated iframe (bare 3speak URL, inserted post-sanitize) also carries the sandbox', () => {
            const html = r.render('https://play.3speak.tv/embed?v=badadib/g9sgdk5h');
            const m = html.match(/<iframe[^>]*\ssandbox="([^"]*)"/i);
            expect(m, 'embedder iframe must have a sandbox').to.not.equal(null);
            const sb = (m as RegExpMatchArray)[1];
            expect(sb).to.contain('allow-scripts');
            expect(sb).to.not.contain('allow-top-navigation');
            expect(sb).to.not.contain('allow-popups');
        });
    });

    describe('arbitrary iframe', () => {
        it('BLOCKS an entirely unknown host', () => blocked('https://evil.example/phish'));
        it('BLOCKS Aureal, whose player cannot play (its API serves an invalid certificate)', () => blocked('https://aureal-embed.web.app/2088949'));
    });
});
