/* eslint-disable no-console -- a CLI self-test script: its output IS the result. */
/**
 * Self-test for the Magi assets read and the BTC mapping decoder. Run:
 *   cd apps/blog && npx tsx lib/lite/wallet/magi-assets.selftest.ts
 *
 * Pure logic only: parsing and decoding against fixtures shaped like the node's
 * real answers. Nothing is fetched.
 */
import { parseMagiAssets, toMagiAccountId } from './magi-assets';
import { btcBalanceKey, decodeBigEndianTrimmedHex, formatSats } from './magi-btc-balance';
import { decodeBigIntBytesHex } from './magi-state';

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail?: string): void {
  checks += 1;
  if (ok) console.log(`ok    ${name}`);
  else {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}
function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

// ── account id normalisation ──
check('bare hive name gets hive: prefix', toMagiAccountId('alice') === 'hive:alice');
check('hive: kept', toMagiAccountId('hive:alice') === 'hive:alice');
check('did:pkh kept verbatim (case preserved)', toMagiAccountId('did:pkh:eip155:1:0xAbC') === 'did:pkh:eip155:1:0xAbC');

// ── parseMagiAssets ──
const full = {
  data: {
    getAccountBalance: {
      account: 'hive:alice',
      block_height: 123,
      hbd: 1284500,
      hbd_savings: 500000,
      pending_hbd_unstaking: null,
      hive: '2310000',
      hive_consensus: 1000000,
      consensus_unstaking: 0
    },
    getAccountRC: { account: 'hive:alice', amount: 1294500, max_rcs: 1294500 }
  }
};
const parsed = parseMagiAssets(full, 'hive:alice');
check('hbd parsed', parsed.hbdBaseUnits === 1284500);
check('hbd savings parsed', parsed.hbdSavingsBaseUnits === 500000);
check('nullable pending_hbd_unstaking -> 0', parsed.hbdUnstakingBaseUnits === 0);
check('hive as string parsed', parsed.hiveBaseUnits === 2310000);
check('consensus parsed', parsed.hiveConsensusBaseUnits === 1000000);
check('rc parsed', parsed.rc.amount === 1294500 && parsed.rc.maxRcs === 1294500);
check('block height parsed', parsed.blockHeight === 123);

const bothNull = { data: { getAccountBalance: null, getAccountRC: null } };
const z = parseMagiAssets(bothNull, 'did:pkh:eip155:1:0xabc');
check('both null == no Magi account == zeros', z.hbdBaseUnits === 0 && z.hiveBaseUnits === 0 && z.rc.amount === 0);

const balNull = { data: { getAccountBalance: null, getAccountRC: { account: 'hive:bob', amount: 10000, max_rcs: 10000 } } };
const b = parseMagiAssets(balNull, 'hive:bob');
check('balance null beside rc row == zero balance with real rc', b.hbdBaseUnits === 0 && b.rc.amount === 10000);

check('rc null beside a balance row throws', throws(() => parseMagiAssets({ data: { getAccountBalance: full.data.getAccountBalance, getAccountRC: null } }, 'hive:alice')));
check('graphql errors throw', throws(() => parseMagiAssets({ errors: [{ message: 'boom' }] }, 'hive:alice')));
check('non-numeric field throws', throws(() => parseMagiAssets({ data: { getAccountBalance: { ...full.data.getAccountBalance, hbd: 'x' }, getAccountRC: full.data.getAccountRC } }, 'hive:alice')));

// ── BTC key + decoder ──
check('btc key is a-<id> with hive: prefix', btcBalanceKey('alice') === 'a-hive:alice');
check('btc key keeps did verbatim', btcBalanceKey('did:pkh:bip122:000000000019d6689c085ae165831e93:bc1qxyz') === 'a-did:pkh:bip122:000000000019d6689c085ae165831e93:bc1qxyz');
check('absent key == 0 (contract deletes at zero)', decodeBigEndianTrimmedHex(null) === BigInt(0) && decodeBigEndianTrimmedHex('') === BigInt(0));
check('one byte 0x01 == 1 sat', decodeBigEndianTrimmedHex('01') === BigInt(1));
check('trimmed big-endian 0x131a (4890) decodes', decodeBigEndianTrimmedHex('131a') === BigInt(4890));
check('0.0125 BTC == 1,250,000 sats == 0x1312d0', decodeBigEndianTrimmedHex('1312d0') === BigInt(1250000));
check('full 8 bytes accepted', decodeBigEndianTrimmedHex('ffffffffffffffff') === BigInt('18446744073709551615'));
check('9 bytes refused (null, not 0)', decodeBigEndianTrimmedHex('01ffffffffffffffff') === null);
check('odd length refused', decodeBigEndianTrimmedHex('abc') === null);
check('non-hex refused', decodeBigEndianTrimmedHex('zz') === null);
check('little-endian would be WRONG: 0xd01213 is not 1,250,000', decodeBigEndianTrimmedHex('d01213') !== BigInt(1250000));
check('formatSats 1,250,000 -> 0.01250000', formatSats(BigInt(1250000)) === '0.01250000');
check('formatSats 0 -> 0.00000000', formatSats(BigInt(0)) === '0.00000000');
check('formatSats 123456789012 -> 1234.56789012', formatSats(BigInt('123456789012')) === '1234.56789012');

// ── DEX pool reserves: Go big.Int.Bytes() as hex (big-endian magnitude, minimal length) ──
check('pool reserve: empty == 0 (zero writes no bytes)', decodeBigIntBytesHex('') === BigInt(0) && decodeBigIntBytesHex(null) === BigInt(0));
check('pool reserve: 0x239c63 (the mainnet r0 the reads.ts doc cites) == 2,333,795', decodeBigIntBytesHex('239c63') === BigInt(2333795));
check('pool reserve: 0x-prefixed accepted', decodeBigIntBytesHex('0x0110ca') === BigInt(69834));
check('pool reserve: non-hex -> null, never 0', decodeBigIntBytesHex('zz') === null);
check('pool reserve: odd length -> null', decodeBigIntBytesHex('abc') === null);
check('pool reserve: large value exact (no float)', decodeBigIntBytesHex('ffffffffffffffffff') === BigInt('4722366482869645213695'));

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
