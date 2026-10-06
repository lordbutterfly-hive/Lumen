import {expect} from 'chai';
import {VimeoEmbedder} from './VimeoEmbedder';

describe('VimeoEmbedder', () => {
    (
        [
            // vimeo links. The whole link is the url (so no query tail is left beside the
            // player as text), and an unlisted video's `h=` hash rides in the id (2026-10-06).
            ['https://player.vimeo.com/video/179213493', '179213493'],
            ['https://player.vimeo.com/video/179213493?h=11571f92bf', '179213493/11571f92bf'],
            ['https://player.vimeo.com/video/179213493?byline=0', '179213493']
        ] as Array<[string, string]>
    ).forEach(([input, id]) => {
        it('should properly return metadata for vimeo video link with player', () => {
            const embedder = new VimeoEmbedder();
            const result = embedder.getEmbedMetadata({data: input} as HTMLObjectElement);
            expect(result).to.be.deep.equal({id, url: input});
        });
    });

    (
        [
            // vimeo links without player
            ['https://vimeo.com/179213493', '179213493'],
            ['https://vimeo.com/179213493?byline=0', '179213493'],
            ['https://www.vimeo.com/179213493', '179213493'],
            ['https://vimeo.com/channels/staffpicks/179213493', '179213493'],
            ['https://vimeo.com/groups/shortfilms/videos/179213493', '179213493'],
            ['https://vimeo.com/179213493/11571f92bf', '179213493/11571f92bf'],
            ['https://vimeo.com/channels/123456/179213493', '179213493']
        ] as Array<[string, string]>
    ).forEach(([input, id]) => {
        it(`should properly return metadata for vimeo video ${input}`, () => {
            const embedder = new VimeoEmbedder();
            const result = embedder.getEmbedMetadata({data: input} as HTMLObjectElement);
            expect(result).to.be.deep.equal({id, url: input});
        });
    });

    it('builds the player url with the hash for an unlisted video, and rejects a hand-typed bad id', () => {
        expect(VimeoEmbedder.generateCanonicalUrl('179213493/11571f92bf')).to.equal('https://player.vimeo.com/video/179213493?h=11571f92bf');
        expect(VimeoEmbedder.generateCanonicalUrl('179213493')).to.equal('https://player.vimeo.com/video/179213493');
        expect(VimeoEmbedder.generateCanonicalUrl('179213493/../../evil')).to.equal(null);
        expect(new VimeoEmbedder().processEmbed('1?x=y', {width: 640, height: 480})).to.equal('');
    });

    it('should return undefined for invalid input', () => {
        const embedder = new VimeoEmbedder();
        const node = {data: 'https://vimeo.com/invalid/179213493'} as HTMLObjectElement;
        const result = embedder.getEmbedMetadata(node);
        expect(result).to.be.undefined;
    });

    it('should return undefined for empty input', () => {
        const embedder = new VimeoEmbedder();
        const node = {data: ''} as HTMLObjectElement;
        const result = embedder.getEmbedMetadata(node);
        expect(result).to.be.undefined;
    });

    it('should return undefined for undefined input', () => {
        const embedder = new VimeoEmbedder();
        const node = {data: undefined} as any as HTMLObjectElement;
        const result = embedder.getEmbedMetadata(node);
        expect(result).to.be.undefined;
    });
});
