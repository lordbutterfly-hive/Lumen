import { expect } from 'chai';
import { isTransient } from '../../retry';
describe('isTransient', () => {
  it('retries a reset socket', () => expect(isTransient(new Error('socket hang up'))).to.equal(true));
  it('retries a 5xx', () => expect(isTransient({ status: 503 })).to.equal(true));
  it('does NOT retry a 4xx', () => expect(isTransient({ status: 404 })).to.equal(false));
  it('does NOT retry a Postgres statement timeout', () =>
    expect(isTransient(new Error('canceling statement due to statement timeout'))).to.equal(false));
  it('does NOT retry SQLSTATE 57014', () => expect(isTransient(new Error('error 57014'))).to.equal(false));
  it('still retries a real request timeout', () =>
    expect(isTransient(new Error('request timed out'))).to.equal(true));
});
