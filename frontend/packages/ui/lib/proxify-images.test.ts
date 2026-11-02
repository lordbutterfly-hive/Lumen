/**
 * GIF proxy URLs (2026-11-02).
 *
 * images.hive.blog only passes a GIF through animated for
 * `format=match&mode=fit` with no width/height. Every other shape is a
 * first-frame still. Post and comment bodies ask for no size and must get the
 * animated shape; sized slots (cards, thumbnails) keep the still.
 */
import { expect } from 'chai';
import { proxifyImageSrc, isGifUrl } from './proxify-images';

const GIF = 'https://static.klipy.com/ii/c3a19a0b747a76e98651f2b9a3cca5ff/df/56/HjyaFBhi.gif';
const PNG = 'https://files.peakd.com/file/peakd-hive/someone/photo.png';

function query(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

describe('proxifyImageSrc GIF handling', () => {
  it('detects GIF urls, with or without a query string', () => {
    expect(isGifUrl(GIF)).to.equal(true);
    expect(isGifUrl(GIF + '?cid=1')).to.equal(true);
    expect(isGifUrl('https://media.tenor.com/abc/love.GIF')).to.equal(true);
    expect(isGifUrl(PNG)).to.equal(false);
    expect(isGifUrl('https://example.com/gif-gallery/photo.jpg')).to.equal(false);
  });

  it('no size asked: GIF gets the animated passthrough shape (format=match&mode=fit, no width/height)', () => {
    const q = query(proxifyImageSrc(GIF, 0, 0));
    expect(q.get('format')).to.equal('match');
    expect(q.get('mode')).to.equal('fit');
    expect(q.has('width')).to.equal(false);
    expect(q.has('height')).to.equal(false);
  });

  it('no size asked with an explicit format and a token: still the passthrough shape, token kept', () => {
    const out = proxifyImageSrc(GIF, 0, 0, 'match', 'tok');
    const q = query(out);
    expect(q.get('format')).to.equal('match');
    expect(q.get('mode')).to.equal('fit');
    expect(q.get('token')).to.equal('tok');
    expect(q.has('width')).to.equal(false);
  });

  it('size asked (card slot): GIF keeps the still shape it had before (format=match only)', () => {
    const q = query(proxifyImageSrc(GIF, 256, 512));
    expect(q.get('format')).to.equal('match');
    expect(q.has('mode')).to.equal(false);
    expect(q.has('width')).to.equal(false);
    expect(q.has('height')).to.equal(false);
  });

  it('non-GIF images are unchanged: webp, mode=fit, requested size', () => {
    const q = query(proxifyImageSrc(PNG, 1420, 0));
    expect(q.get('format')).to.equal('webp');
    expect(q.get('mode')).to.equal('fit');
    expect(q.get('width')).to.equal('1420');
    expect(q.has('height')).to.equal(false);
  });

  it('the GIF passthrough url points at the same /p/<base58> as the original url', () => {
    const out = proxifyImageSrc(GIF, 0, 0);
    expect(out.startsWith('https://images.hive.blog/p/')).to.equal(true);
    const still = proxifyImageSrc(GIF, 256, 512);
    expect(out.split('?')[0]).to.equal(still.split('?')[0]);
  });
});
