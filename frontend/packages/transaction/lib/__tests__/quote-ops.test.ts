import { describe, it } from 'mocha';
import { expect } from 'chai';
import {
  DELETED_BODY,
  blankedJsonMetadata,
  linkText,
  quoteCommentBody,
  quoteLinkLine,
  undoReblogOperation
} from '../quote-ops';
import { stripAttributionFooter } from '../attribution';

/**
 * Quote reblogs (spec v2 2.3, 4, 7.4): what a full Hive account signs. The chain-facing
 * shapes are pinned here because a wrong one is only discovered when Hive rejects it.
 */
describe('quote reblog operations', () => {
  const native = { author: 'bob', permlink: 'how-rc-works', title: 'How RC works', url: 'https://lumensocial.net/hive-139531/@bob/how-rc-works' };

  it('a removed quote is never left with an empty body (hived: "Body is empty")', () => {
    expect(DELETED_BODY.trim()).to.not.equal('');
  });

  it('names a Hive author with @ (Hive notifies them, as intended)', () => {
    expect(quoteLinkLine(native)).to.equal('Reblogged from @bob: [How RC works](https://lumensocial.net/hive-139531/@bob/how-rc-works)');
  });

  it('names a Lumen (lite) author WITHOUT @: the handle is not a Hive account', () => {
    const line = quoteLinkLine({ ...native, author: 'lumenpublisher', lite: { handle: 'bob' } });
    expect(line).to.equal('Reblogged from a post by bob on Lumen: [How RC works](https://lumensocial.net/hive-139531/@bob/how-rc-works)');
    expect(line).to.not.match(/@bob\b(?!\/)/);
    expect(line).to.not.contain('@lumenpublisher');
  });

  it('link text: one line, brackets escaped, clipped, never empty', () => {
    expect(linkText('a [b]\nc')).to.equal('a \\[b\\] c');
    expect(linkText('   ')).to.equal('this post');
    expect(linkText('x'.repeat(300)).length).to.equal(120);
  });

  it('body: caption, blank line, link line, then the attribution footer', () => {
    const body = quoteCommentBody('  Clearest RC explainer.  ', native);
    expect(stripAttributionFooter(body)).to.equal(`Clearest RC explainer.\n\n${quoteLinkLine(native)}`);
    expect(body).to.match(/\*Posted via Lumen\*$/);
  });

  it('the caption cache cut (server captionOf) finds the link line', () => {
    const body = quoteCommentBody('Line one\n\nLine two', native);
    const cut = body.search(/\n\s*\n(?:Reblogged from |Reblogged by |\[Reblogged)/);
    expect(body.slice(0, cut)).to.equal('Line one\n\nLine two');
  });

  it('undo reblog: the follow custom_json with delete, posting auth of the account', () => {
    const op = undoReblogOperation('alice', 'bob', 'how-rc-works');
    expect(op.custom_json_operation.id).to.equal('follow');
    expect(op.custom_json_operation.required_posting_auths).to.deep.equal(['alice']);
    expect(op.custom_json_operation.required_auths).to.deep.equal([]);
    expect(JSON.parse(op.custom_json_operation.json)).to.deep.equal([
      'reblog',
      { account: 'alice', author: 'bob', permlink: 'how-rc-works', delete: 'delete' }
    ]);
  });

  it('blanked metadata keeps the quote marker, refreshes app, adds deleted', () => {
    const meta = blankedJsonMetadata(
      JSON.stringify({ app: 'peakd/1', type: 'lumen_quote', quote_of: { author: 'bob', permlink: 'p' } }),
      'lumen/1.0'
    );
    expect(meta).to.deep.equal({ app: 'lumen/1.0', type: 'lumen_quote', quote_of: { author: 'bob', permlink: 'p' }, deleted: true });
    expect(blankedJsonMetadata('not json', 'lumen/1.0')).to.deep.equal({ app: 'lumen/1.0', deleted: true });
  });
});
