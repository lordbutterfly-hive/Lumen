/**
 * DRIFT GUARD for the local EAssetName mirror (2026-09-04).
 *
 * asset-constants.ts declares a LOCAL `EAssetName` enum instead of importing
 * wax's, so that @hive/ui (imported by 100+ components app-wide) does not drag
 * the ~220 KB @hiveio/wax runtime into every page's first load for a numeric
 * precision. That optimisation is only safe while the local copy stays
 * byte-identical to wax's real enum: `getPrecision`/`getNai` index
 * `chain.ASSETS` (a Record keyed by wax's EAssetName string VALUES) with the
 * local enum's values, so if the local mirror ever drifted (a typo, a removed
 * member, a changed value) the lookup would return undefined -> throw on
 * `.precision`, silently breaking HP/asset math.
 *
 * NOTE: this asserts the local enum against the three fixed Hive asset symbols
 * rather than importing wax's enum to deep-compare, because @hiveio/wax cannot
 * be require()'d under this package's ts-node/mocha CJS runner (its package
 * exports resolve ESM-only) - which is the same reason the runtime mirror exists.
 * These three symbols (HIVE/HBD/VESTS) are fundamental Hive protocol constants,
 * hardcoded across the whole ecosystem; wax renaming them is not a realistic
 * event, whereas an accidental edit to the local mirror IS - and that is exactly
 * what this catches. If this fails, reconcile asset-constants.ts's EAssetName
 * with the real Hive asset symbols; do not just edit the test.
 */
import { describe, it } from 'mocha';
import { expect } from 'chai';
import { EAssetName } from './asset-constants';

describe('EAssetName local mirror drift guard', () => {
  it('maps each member to its own name as the string value', () => {
    expect(EAssetName.HIVE).to.equal('HIVE');
    expect(EAssetName.HBD).to.equal('HBD');
    expect(EAssetName.VESTS).to.equal('VESTS');
  });

  it('has EXACTLY the three Hive asset symbols and no others', () => {
    const values = Object.values(EAssetName).filter((v) => typeof v === 'string');
    expect(values.sort()).to.deep.equal(['HBD', 'HIVE', 'VESTS']);
  });
});
