import { expect } from 'chai';
import { isTransient } from '../retry';

/**
 * Regression documenting WHY the post-page bridge reads (getPost, getDiscussion,
 * getCommunity, getFollowList in bridge-api.ts) were moved OFF `./retry`'s
 * withRetry and ONTO `@smart-signer` withHiveRetry on 2026-09-03.
 *
 * The reads intermittently hard-failed on api.hive.blog 429s (the single
 * configured node routinely rate-limits us) with no attempt on a healthy node.
 * Root cause proven here: withRetry classifies a 429 as a FINAL answer, so it
 * neither retries nor (it has no node-rotation at all) fails over. withHiveRetry
 * instead classifies the same 429 as a network fault ("possible network or CORS
 * error") and rotates to the next node — that half is covered by the type-checked
 * build and by the prod log showing "failing over to <node>" on a 429 (it cannot
 * be unit-imported here: its module pulls @hiveio/wax through package-exports the
 * mocha/ts-node runner does not expose).
 */
describe('post-read failover: why withRetry was the wrong wrapper for a 429', () => {
  // Faithful to wax's shape: a 429 arrives with response.status = 429.
  const wax429 = Object.assign(
    new Error(
      'Unknown request error caught (possible network or CORS error): "POST https://api.hive.blog": #429'
    ),
    { name: 'WaxError', response: { status: 429 } }
  );

  it('withRetry treats a 429 as a FINAL answer (isTransient=false) -> no retry, no failover', () => {
    expect(isTransient(wax429)).to.equal(false);
  });

  it('and a bare 429 with no status field is also not transient to withRetry', () => {
    const msgOnly = Object.assign(new Error('gateway said #429 Too Many Requests'), { name: 'WaxError' });
    expect(isTransient(msgOnly)).to.equal(false);
  });

  it('control: withRetry DOES retry a transport fault (ECONNRESET) and a 5xx', () => {
    expect(isTransient(Object.assign(new Error('socket hang up ECONNRESET'), { name: 'Error' }))).to.equal(true);
    expect(isTransient(Object.assign(new Error('bad gateway'), { response: { status: 503 } }))).to.equal(true);
  });

  it('control: withRetry does NOT retry a genuine 404 answer', () => {
    expect(isTransient(Object.assign(new Error('not found'), { response: { status: 404 } }))).to.equal(false);
  });
});
