import { expect } from 'chai';

/**
 * A local mirror of `apps/blog/lib/lite/auth/btc-verify.ts`'s guard.
 *
 * ★ WHY A MIRROR RATHER THAN AN IMPORT. `packages/transaction` cannot import from
 * `apps/blog` (wrong direction, and the app is not a dependency of the package). The
 * alternative was no test at all for a money-loss guard, which is worse. If the two ever
 * diverge this test still holds the LINE the guard has to hold, which is the part that
 * matters: what Magi's `ParseBtcDID` can verify.
 */
function isMagiSignableBtcAddress(address: string): boolean {
  const a = address.trim();
  if (!a || /^(bc1p|tb1p|bcrt1p)/i.test(a)) return false;
  if (/^bc1q[02-9ac-hj-np-z]+$/i.test(a)) return true;
  if (/^[13][1-9A-HJ-NP-Za-km-z]{25,39}$/.test(a)) return true;
  return false;
}

describe('isMagiSignableBtcAddress', () => {
  describe('accepts the three mainnet forms Magi can verify', () => {
    it('P2PKH', () => expect(isMagiSignableBtcAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).to.equal(true));
    it('P2SH', () => expect(isMagiSignableBtcAddress('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy')).to.equal(true));
    it('P2WPKH', () =>
      expect(isMagiSignableBtcAddress('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')).to.equal(true));
  });

  describe('refuses everything that would be funded-but-unspendable', () => {
    // The exact defect: dids.Parse never calls ParseBtcTestnetDID.
    it('testnet bech32 (tb1)', () =>
      expect(isMagiSignableBtcAddress('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx')).to.equal(false));
    it('testnet P2PKH (m)', () =>
      expect(isMagiSignableBtcAddress('mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn')).to.equal(false));
    it('testnet P2PKH (n)', () =>
      expect(isMagiSignableBtcAddress('n2eMqTT929pb1RDNuqEnxdaLau1rxy3efi')).to.equal(false));
    it('testnet P2SH (2)', () =>
      expect(isMagiSignableBtcAddress('2N2JD6wb56AfK4tfmM6PwdVmoYk2dCKf4Br')).to.equal(false));
    // The one a blocklist missed: regtest is NOT tb1/m/n/2, so it was labelled mainnet.
    it('regtest (bcrt1) - the case the old blocklist mislabelled as mainnet', () =>
      expect(isMagiSignableBtcAddress('bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080')).to.equal(false));
    it('mainnet Taproot (bc1p) - verifier declines it too', () =>
      expect(isMagiSignableBtcAddress('bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr')).to.equal(false));
    it('empty', () => expect(isMagiSignableBtcAddress('')).to.equal(false));
    it('an Ethereum address', () =>
      expect(isMagiSignableBtcAddress('0xf434aB1cA4C0a1Ee6a0f0bD1F3f3f3f3f3f3329b')).to.equal(false));
  });
});
