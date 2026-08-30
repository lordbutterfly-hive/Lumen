import { describe, it } from 'mocha';
import { expect } from 'chai';
import {
  appendAttributionFooter,
  stripAttributionFooter,
  hasAttributionFooter,
  LUMEN_APP_METADATA
} from '../attribution';

/**
 * On-chain "Posted via Lumen" attribution for full-Hive-account posts and
 * comments (owner instruction, 2026-08-28). The property that matters most is
 * IDEMPOTENCY: publishing or editing the same content any number of times
 * must always leave exactly one footer on the wire, never zero and never
 * stacked.
 */
describe('appendAttributionFooter', () => {
  const draft = 'Hello world, this is my first post.';
  const published = `${draft}\n\n---\n*Posted via Lumen*`;

  it('appends exactly one footer to a clean body', () => {
    expect(appendAttributionFooter(draft)).to.equal(published);
  });

  it('re-publishing an already-attributed body stays single (create -> immediate re-save)', () => {
    expect(appendAttributionFooter(published)).to.equal(published);
  });

  it('editing the body while the footer is still visible does not double it', () => {
    const editorShowsFooter = published; // what the round-tripped editor displays
    const userEdited = editorShowsFooter.replace(draft, 'Hello world, this is my EDITED post.');
    expect(appendAttributionFooter(userEdited)).to.equal(
      'Hello world, this is my EDITED post.\n\n---\n*Posted via Lumen*'
    );
  });

  it('is stable under repeated application, not cumulative', () => {
    let body = draft;
    for (let i = 0; i < 5; i++) body = appendAttributionFooter(body);
    expect(body).to.equal(published);
  });

  it('collapses a pre-existing DOUBLE footer (a non-idempotent build could have produced) to exactly one', () => {
    const doubled = `${draft}\n\n---\n*Posted via Lumen*\n\n---\n*Posted via Lumen*`;
    expect(appendAttributionFooter(doubled)).to.equal(published);
  });

  it('re-adds the footer if the user deletes the visible one in the editor', () => {
    expect(appendAttributionFooter(draft)).to.equal(published);
  });

  it('produces a single footer on an empty body', () => {
    expect(appendAttributionFooter('')).to.equal('\n\n---\n*Posted via Lumen*');
  });
});

describe('stripAttributionFooter', () => {
  it('leaves an unrelated hr + italic sign-off untouched', () => {
    const body = 'body text\n\n---\n*Thanks for reading!*';
    expect(stripAttributionFooter(body)).to.equal(body);
  });

  it('does not touch matching text in the middle of the body, only the trailing one', () => {
    const body = 'I love writing *Posted via Lumen* posts.\n\n---\n*Posted via Lumen*';
    expect(stripAttributionFooter(body)).to.equal('I love writing *Posted via Lumen* posts.');
  });

  it('defensively strips the lite "by {name}" variant too, so an account that upgrades mid-edit never ends up with two footers', () => {
    expect(stripAttributionFooter('body text\n\n---\n*Posted via Lumen by satoshi*')).to.equal('body text');
  });
});

describe('LUMEN_APP_METADATA', () => {
  it('matches the value the lite path and post()/updatePost() already broadcast', () => {
    expect(LUMEN_APP_METADATA).to.equal('lumen/1.0');
  });
});

/**
 * The renderer half of the same rule. `PostedViaLumen` (Lumen's own styled
 * byline) asks this before painting, so Lumen shows attribution ONCE — the body
 * footer — instead of the footer plus a byline underneath it. Owner, 2026-08-28:
 * "only make it show up once ... dont make it show twice."
 *
 * Both directions matter and both are asserted below. A false NEGATIVE prints
 * attribution twice (the bug being fixed). A false POSITIVE suppresses the
 * byline on an entry whose body has no footer, printing it ZERO times — which
 * is worse, because it silently drops the attribution the owner requires.
 */
describe('hasAttributionFooter', () => {
  const draft = 'Hello world, this is my first post.';

  it('★ is TRUE for a body the publisher actually attributed', () => {
    expect(hasAttributionFooter(appendAttributionFooter(draft))).to.equal(true);
  });

  it('★ is TRUE for the lite variant, which names the writer', () => {
    expect(hasAttributionFooter(`${draft}\n\n---\n*Posted via Lumen by alice*`)).to.equal(true);
  });

  it('★ is FALSE for a plain body, so the byline still renders (never zero)', () => {
    expect(hasAttributionFooter(draft)).to.equal(false);
  });

  it('★ is FALSE for a lite entry read from our DB, where the footer is only added at broadcast', () => {
    // publisher/worker.ts appends the footer at broadcast time; the row never stores it.
    expect(hasAttributionFooter(stripAttributionFooter(appendAttributionFooter(draft)))).to.equal(false);
  });

  it('is FALSE when the same words appear mid-post rather than as the footer', () => {
    expect(hasAttributionFooter(`I was told:\n\n---\n*Posted via Lumen*\n\nand then I kept writing.`)).to.equal(
      false
    );
  });

  it('is FALSE for an unrelated sign-off under a rule', () => {
    expect(hasAttributionFooter(`${draft}\n\n---\n*Thanks for reading*`)).to.equal(false);
  });

  it('tolerates a missing or empty body by rendering the byline (fails safe)', () => {
    expect(hasAttributionFooter(undefined)).to.equal(false);
    expect(hasAttributionFooter(null)).to.equal(false);
    expect(hasAttributionFooter('')).to.equal(false);
  });

  it('★ agrees with the writer: whatever append produces, this recognises', () => {
    for (const body of [draft, '', 'a', `${draft}\n\n---\n*Posted via Lumen*`, 'x\n\n\n---\n*Posted via Lumen*']) {
      expect(hasAttributionFooter(appendAttributionFooter(body)), JSON.stringify(body)).to.equal(true);
    }
  });
});
