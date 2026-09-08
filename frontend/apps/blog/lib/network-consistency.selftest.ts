/* eslint-disable no-console -- a CLI self-test script: its output IS the result. */
/**
 * Run: cd apps/blog && npx tsx lib/network-consistency.selftest.ts
 */
import { HIVE_MAINNET_CHAIN_ID, checkNetworkConsistency } from './network-consistency';

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean): void {
  checks += 1;
  if (ok) console.log(`ok    ${name}`);
  else {
    failures += 1;
    console.error(`FAIL  ${name}`);
  }
}
const TESTNET_CHAIN = '18dcf0a285365fc58b71f18b3d3fec954aa0c141c44e4e5cb4cf777b9eab274e';

check('prod: vsc-mainnet + unset L1 (mainnet default) passes', checkNetworkConsistency({ REACT_APP_CREATOR_TOKENS_NET_ID: 'vsc-mainnet' }).ok);
check('prod: vsc-mainnet + explicit mainnet passes', checkNetworkConsistency({ REACT_APP_CREATOR_TOKENS_NET_ID: 'vsc-mainnet', REACT_APP_CHAIN_ID: HIVE_MAINNET_CHAIN_ID }).ok);
check('testnet stack: vsc-testnet + testnet L1 passes', checkNetworkConsistency({ REACT_APP_CREATOR_TOKENS_NET_ID: 'vsc-testnet', REACT_APP_CHAIN_ID: TESTNET_CHAIN, REACT_APP_API_ENDPOINT: 'https://testnet.techcoderx.com' }).ok);
check('THE BUG: vsc-testnet + unset L1 (mainnet default) REFUSED', !checkNetworkConsistency({ REACT_APP_CREATOR_TOKENS_NET_ID: 'vsc-testnet' }).ok);
check('vsc-testnet + explicit mainnet L1 REFUSED', !checkNetworkConsistency({ REACT_APP_CREATOR_TOKENS_NET_ID: 'vsc-testnet', REACT_APP_CHAIN_ID: HIVE_MAINNET_CHAIN_ID }).ok);
check('the refusal names the fix', /LUMEN_ALLOW_MIXED_NETWORKS/.test(checkNetworkConsistency({ REACT_APP_CREATOR_TOKENS_NET_ID: 'vsc-testnet' }).message));
check('escape hatch: vsc-testnet + mainnet L1 + LUMEN_ALLOW_MIXED_NETWORKS=yes passes, and says so', (() => { const r = checkNetworkConsistency({ REACT_APP_CREATOR_TOKENS_NET_ID: 'vsc-testnet', LUMEN_ALLOW_MIXED_NETWORKS: 'yes' }); return r.ok && /ALLOWED/.test(r.message); })());
check('escape hatch is exact: "true" is not "yes"', !checkNetworkConsistency({ REACT_APP_CREATOR_TOKENS_NET_ID: 'vsc-testnet', LUMEN_ALLOW_MIXED_NETWORKS: 'true' }).ok);
check('reverse mix: vsc-mainnet + testnet L1 REFUSED', !checkNetworkConsistency({ REACT_APP_CREATOR_TOKENS_NET_ID: 'vsc-mainnet', REACT_APP_CHAIN_ID: TESTNET_CHAIN }).ok);
check('no Magi provisioned: anything passes', checkNetworkConsistency({}).ok && checkNetworkConsistency({ REACT_APP_CHAIN_ID: TESTNET_CHAIN }).ok);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
