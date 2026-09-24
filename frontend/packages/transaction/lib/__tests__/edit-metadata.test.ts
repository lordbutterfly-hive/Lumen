import { describe, it } from 'mocha';
import { expect } from 'chai';
import { mergeEditJsonMetadata } from '../edit-metadata';

const APP = 'lumen/1.0';

describe('mergeEditJsonMetadata', () => {
  it('★ keeps a reblog comment\'s quote marker through an edit', () => {
    const existing = { app: 'lumen/1.0', format: 'markdown', type: 'lumen_quote', quote_of: { author: 'bob', permlink: 'p' }, tags: ['lumen'] };
    expect(mergeEditJsonMetadata(existing, APP)).to.deep.equal(existing);
  });
  it('reads the chain\'s JSON-string form the same way', () => {
    expect(mergeEditJsonMetadata('{"tags":["hive"],"format":"markdown"}', APP)).to.deep.equal({ tags: ['hive'], format: 'markdown', app: APP });
  });
  it('refreshes app even when another frontend wrote it', () => {
    expect(mergeEditJsonMetadata({ app: 'peakd/2024', tags: ['x'] }, APP)).to.deep.equal({ app: APP, tags: ['x'] });
  });
  it('falls back to {app} for anything unreadable (the previous behaviour)', () => {
    for (const bad of [undefined, null, '', 'not json', '[1,2]', [1, 2], 42]) {
      expect(mergeEditJsonMetadata(bad, APP)).to.deep.equal({ app: APP });
    }
  });
});
