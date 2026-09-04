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

    describe('YouTube', () => {
        it('renders a valid embed rebuilt to the real host', () => {
            const html = r.render('<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1"></iframe>');
            expect(iframeSrcs(html)).to.deep.equal(['https://www.youtube.com/embed/dQw4w9WgXcQ']);
        });
        it('BLOCKS the look-alike host (unescaped-dot bypass)', () => blocked('//www-youtube.com/embed/dQw4w9WgXcQ'));
        it('BLOCKS a subdomain-suffix host', () => blocked('https://www.youtube.com.evil.com/embed/dQw4w9WgXcQ'));
        it('BLOCKS a userinfo host', () => blocked('https://www.youtube.com@evil.com/embed/dQw4w9WgXcQ'));
        it('strips a trailing path after a valid id (garbage not folded into the rebuilt src)', () => {
            const html = r.render('<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ/../../evil"></iframe>');
            expect(iframeSrcs(html)).to.deep.equal(['https://www.youtube.com/embed/dQw4w9WgXcQ']);
        });
        it('BLOCKS a 12-char id (wrong length, no boundary)', () => blocked('https://www.youtube.com/embed/dQw4w9WgXcQX'));
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
        it('renders a bare play.3speak.tv embed URL, rebuilt to the 3speak.tv host', () => {
            const html = r.render('https://play.3speak.tv/embed?v=badadib/g9sgdk5h');
            expect(iframeSrcs(html)).to.deep.equal(['https://3speak.tv/embed?v=badadib/g9sgdk5h']);
        });
        it('does NOT embed 3speak when the url is only a substring of another link', () => {
            const html = r.render('<a href="https://evil.com/?x=3speak.tv/watch?v=a/b">x</a>');
            expect(iframeSrcs(html)).to.have.length(0);
        });
    });

    describe('sandbox', () => {
        it('every rendered embed carries a sandbox WITHOUT top-navigation or popups', () => {
            const html = r.render('<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>');
            const m = html.match(/<iframe[^>]*\ssandbox="([^"]*)"/i);
            expect(m, 'iframe must have a sandbox attribute').to.not.equal(null);
            const sb = (m as RegExpMatchArray)[1];
            expect(sb).to.contain('allow-scripts');
            expect(sb).to.contain('allow-same-origin');
            expect(sb).to.not.contain('allow-top-navigation');
            expect(sb).to.not.contain('allow-popups');
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
    });
});
