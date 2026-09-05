import { expect } from 'chai';
import { bannedFollowEdgesEnabled, BANNED_FOLLOW_EDGES_ENV } from '../profile-fanout-config';

/**
 * The switch that decides whether a cache-cold `getAccountFull` pays twelve
 * extra `get_relationship_between_accounts` calls. Two properties matter and
 * both are asserted here: the DEFAULT is today's behaviour (so deploying the
 * switch changes nothing until somebody sets it), and only the exact word `no`
 * turns it off (so a typo cannot quietly stop correcting follower counts).
 */
const set = (value: string | undefined): Record<string, string | undefined> => ({
  [BANNED_FOLLOW_EDGES_ENV]: value
});

describe('bannedFollowEdgesEnabled: the fan-out kill switch', () => {
  it('defaults to ENABLED when the variable is unset or absent', () => {
    expect(bannedFollowEdgesEnabled({})).to.equal(true);
    expect(bannedFollowEdgesEnabled(set(undefined))).to.equal(true);
  });

  it("is disabled ONLY by 'no', case-insensitively and whitespace-tolerantly", () => {
    for (const off of ['no', 'NO', 'No', ' no ', '\tno\n']) {
      expect(bannedFollowEdgesEnabled(set(off)), `"${off}" must disable`).to.equal(false);
    }
  });

  it("stays ENABLED for 'yes' and for every other spelling of falsey", () => {
    // Deliberate: this gate decides what the site DISPLAYS. A follower count
    // that stops being corrected because somebody wrote `false` where the code
    // wanted `no` is worse than a switch that did not take.
    for (const on of ['yes', 'YES', ' yes ', 'true', 'false', '0', '1', 'off', 'disabled', 'n', '', '   ']) {
      expect(bannedFollowEdgesEnabled(set(on)), `"${on}" must stay enabled`).to.equal(true);
    }
  });

  it('never throws and always returns a boolean, whatever the environment holds', () => {
    for (const value of [undefined, '', 'no', 'anything']) {
      expect(bannedFollowEdgesEnabled(set(value))).to.be.a('boolean');
    }
    expect(bannedFollowEdgesEnabled()).to.be.a('boolean');
  });

  it('negative control: a naive Boolean(raw) would get every one of these wrong', () => {
    // Boolean('no') === true (would leave it enabled when asked to disable) and
    // Boolean('') === false (would disable it on an empty value). The explicit
    // comparison above is what makes the switch predictable.
    expect(Boolean('no')).to.equal(true);
    expect(Boolean('')).to.equal(false);
    expect(bannedFollowEdgesEnabled(set('no'))).to.equal(false);
    expect(bannedFollowEdgesEnabled(set(''))).to.equal(true);
  });
});
