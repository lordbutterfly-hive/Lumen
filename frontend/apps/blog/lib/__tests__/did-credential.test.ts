/**
 * UNIT TESTS for `lib/lite/wallet/did-credential.ts`: a Meritum buyer's `did:pkh` back to
 * the stored wallet credential, which is how a creator's "Message" reaches a wallet buyer.
 * Run by `pnpm --filter @hive/blog test:unit` under ts-node; own harness.
 *
 * The load-bearing rule: the DID carries EIP-55 casing but the credential row stores the
 * EVM address lowercase, while a base58 Bitcoin address must keep its case. Getting either
 * wrong finds no account, and the buyer is shown as "not set up" when they are.
 */
import { walletRefForDid } from '../lite/wallet/did-credential';
import { walletDid } from '../lite/wallet/did-pkh';

let checks = 0;
let failures = 0;
function ok(label: string, pass: boolean, detail = '') {
  checks++;
  if (pass) console.log(`  ok    ${label}`);
  else {
    failures++;
    console.error(`  FAIL  ${label}${detail ? ` - ${detail}` : ''}`);
  }
}

const EVM_LOWER = '0x742d35cc6634c0532925a3b844bc9e7595f0beb7';
const EVM_DID = 'did:pkh:eip155:1:0x742D35Cc6634C0532925A3B844bC9e7595f0bEB7';
const BTC_BECH32 = 'bc1qp66mahgkgn073xc6je5jyutn09q34fs0pwvepk';
const BTC_BASE58 = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
const BTC_MAINNET = '000000000019d6689c085ae165831e93';

const evm = walletRefForDid(EVM_DID);
ok('an EIP-55 DID finds the lowercase stored ref', evm?.method === 'evm_wallet' && evm.externalRef === EVM_LOWER, JSON.stringify(evm));

const built = walletDid('evm_wallet', EVM_LOWER, 'eip155') as string;
const back = walletRefForDid(built);
ok('EVM round trip: stored ref -> walletDid -> walletRefForDid is the stored ref', back?.externalRef === EVM_LOWER, `${built} -> ${JSON.stringify(back)}`);

const bech = walletRefForDid(`did:pkh:bip122:${BTC_MAINNET}:${BTC_BECH32}`);
ok('a bech32 DID finds the btc_wallet ref', bech?.method === 'btc_wallet' && bech.externalRef === BTC_BECH32, JSON.stringify(bech));

const upperBech = walletRefForDid(`did:pkh:bip122:${BTC_MAINNET}:${BTC_BECH32.toUpperCase()}`);
ok('an uppercase bech32 DID lowercases like the login route does', upperBech?.externalRef === BTC_BECH32, JSON.stringify(upperBech));

const base58 = walletRefForDid(`did:pkh:bip122:${BTC_MAINNET}:${BTC_BASE58}`);
ok('a base58 DID keeps its case byte for byte', base58?.externalRef === BTC_BASE58, JSON.stringify(base58));

const btcBuilt = walletDid('btc_wallet', BTC_BASE58, 'bitcoin') as string;
ok('BTC round trip keeps the stored ref', walletRefForDid(btcBuilt)?.externalRef === BTC_BASE58, btcBuilt);

ok('a non-wallet namespace is not a wallet', walletRefForDid('did:pkh:solana:mainnet:abc') === null);
ok('a malformed EVM address is refused', walletRefForDid('did:pkh:eip155:1:0x1234') === null);
ok('something that is not a did:pkh is refused', walletRefForDid('hive:someone') === null);
ok('a DID with no address is refused', walletRefForDid('did:pkh:eip155:1') === null);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
