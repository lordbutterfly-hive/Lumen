// The "test file" for did-pkh.ts — same shape and rationale as
// magi-balance.selftest.ts and the creator-tokens selftests (apps/blog has no
// unit runner; see features/creator-tokens/lib/vsc/payload-contract.selftest.ts
// for the full survey of why these are self-invoking checkers).
//
// Run by hand: `npx tsx lib/lite/wallet/did-pkh.selftest.ts` from apps/blog.
//
// WHAT THIS GUARDS (2026-08-19). `walletDid` used to lowercase the EVM address.
// The node compares recovered addresses with `strings.EqualFold`
// (lib/dids/eth.go:169), so a lowercase DID SIGNS AND VERIFIES PERFECTLY — and
// then reads zero balance and zero RC, because the ledger keys on the exact
// string and canonicalises to EIP-55. RC *is* the HBD balance, so every submit
// is refused "not enough RCS available" while the money sits under the
// checksummed key. Nothing fails loudly; it just never works.
//
// The same case-folding is a sybil hole: two casings are two independently
// authenticated callers for one key, which defeats one-market-per-creator, the
// delinquency gate and the self-deal filter
// (LUMEN-DOCS/creator-tokens/FINDING-did-case-identity-2026-07-28.md).
//
// ★ And the half that makes a blanket fix WRONG: Bitcoin base58 is
// case-sensitive, so normalising every account would corrupt bip122 identities.
// The last two checks exist to fail if anyone ever "tidies" that up.

import { walletDid } from './did-pkh';

const LOWER = '0x742d35cc6634c0532925a3b844bc9e7595f0beb7';
const MIXED = '0x742D35Cc6634C0532925a3b844Bc9e7595f0bEb7';
const EIP55 = 'did:pkh:eip155:1:0x742D35Cc6634C0532925A3B844bC9e7595f0bEB7';

export function runDidPkhSelfTest(): void {
  const failures: string[] = [];
  const check = (name: string, ok: boolean, detail = ''): void => {
    if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  };

  const fromLower = walletDid('evm_wallet', LOWER, null);
  const fromMixed = walletDid('evm_wallet', MIXED, null);

  check('a lowercase address yields the EIP-55 DID', fromLower === EIP55, String(fromLower));
  check('a mixed-case address yields the same EIP-55 DID', fromMixed === EIP55, String(fromMixed));
  check('the derivation is canonical (casing in cannot change the identity out)', fromLower === fromMixed);
  check('the DID is NOT the lowercase form', fromLower !== `did:pkh:eip155:1:${LOWER}`);
  check('whitespace is trimmed before checksumming', walletDid('evm_wallet', `  ${LOWER}  `, null) === EIP55);

  // ★ Bitcoin must keep its case, byte for byte. base58 is case-sensitive.
  const btcMixed = 'bc1qAbCdEf';
  check(
    'a bip122 DID preserves address case verbatim',
    walletDid('btc_wallet', btcMixed, null)?.endsWith(`:${btcMixed}`) === true,
    String(walletDid('btc_wallet', btcMixed, null))
  );
  check(
    'a bip122 testnet DID also preserves case',
    walletDid('btc_wallet', btcMixed, 'testnet')?.endsWith(`:${btcMixed}`) === true
  );

  // A method with no keypair behind it holds nothing and must not mint a DID.
  check('a non-wallet method yields no DID', walletDid('google' as never, 'someone@example.com', null) === null);
  check('an empty address yields no DID', walletDid('evm_wallet', '   ', null) === null);

  if (failures.length > 0) {
    throw new Error(`did-pkh self-test FAILED:\n- ${failures.join('\n- ')}`);
  }
}

if (process.env.NODE_ENV !== 'production') {
  runDidPkhSelfTest();
}
