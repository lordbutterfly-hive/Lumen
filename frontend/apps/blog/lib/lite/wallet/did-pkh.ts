import { AuthMethod } from '../types';
import { checksumEvmAddress } from '@/blog/lib/lite/auth/evm-verify';

/**
 * Turn a bound wallet credential into the Magi account identifier for that wallet.
 *
 * Magi/VSC treats a wallet as a first-class account via `did:pkh`, and the
 * creator-token contract keys balances by an opaque caller string — so a lite user
 * with a wallet can own tokens with no Hive account at all. This module is the whole
 * of what the LITE side has to provide for that: the identifier. No schema change,
 * no new proof, no signing.
 *
 * Formats verified against go-vsc-node source:
 *   EVM  `did:pkh:eip155:1:<0x…>`                        (lib/dids/eth.go:36)
 *   BTC  `did:pkh:bip122:<32-hex genesis>:<address>`      (lib/dids/btc.go:31,35)
 *
 * Case rules, which differ per chain and matter:
 *   - EVM verification compares with EqualFold (eth.go:169), so our lowercased
 *     `external_ref` is fine as-is.
 *   - Bitcoin addresses are NOT normalised by Magi — base58 is case-sensitive, so the
 *     address must be passed through exactly as the user's wallet produced it.
 *
 * NOT authorisation. Holding or moving tokens needs a signature over the real Magi
 * transaction (EIP-712 `tx_container_v0` for EVM; BIP-137/322 over the tx CID for
 * BTC) — a different payload from the login proof we collect today. This module
 * deliberately stops at identity.
 */

/** CAIP-2 chain ids: first 32 hex chars of each network's genesis hash. */
const BTC_MAINNET_CAIP2 = '000000000019d6689c085ae165831e93';
const BTC_TESTNET_CAIP2 = '000000000933ea01ad0ee984209779ba';

/** EVM namespace label. The address is identical on every EVM chain. */
const EVM_CAIP2 = 'eip155:1';

export interface WalletDid {
  method: AuthMethod;
  address: string;
  did: string;
  /** 'bitcoin' | 'testnet' | 'eip155' — as stored on the credential. */
  network: string | null;
}

/**
 * The `did:pkh` for a credential, or null when that method has no wallet key (a
 * Google-only account cannot hold tokens: there is no keypair behind it, and Magi
 * recognises nothing OAuth-shaped).
 */
export function walletDid(
  method: AuthMethod,
  externalRef: string,
  network?: string | null
): string | null {
  const address = externalRef.trim();
  if (!address) return null;

  if (method === 'evm_wallet') {
    // ★ EIP-55 CHECKSUMMED, NOT LOWERCASE (DEFECT FIX 2026-08-19).
    //
    // This used to be `address.toLowerCase()`. Signature verification would not
    // have cared — go-vsc-node compares recovered addresses with
    // `strings.EqualFold` (lib/dids/eth.go:169) — which is exactly what makes the
    // bug so expensive: a lowercase DID signs and verifies perfectly while
    // reading ZERO balance and ZERO resource credits, because the ledger keys on
    // the exact string and canonicalises to EIP-55
    // (modules/ledger-system/ledger_system.go:1186,
    // modules/state-processing/utils.go:61), and `GetBalance` does not normalise.
    // Since RC *is* the HBD balance (modules/rc-system/rc-system.go:33), every
    // submit would be refused "not enough RCS available" while the money sat
    // under the checksummed key — a funding bug wearing a signing bug's clothes.
    //
    // It is also a sybil hole, and that half is already written up and confirmed:
    // case-folding makes `0xAbCd…` and `0xabcd…` two independently-authenticated
    // callers for ONE key, which defeats one-market-per-creator, the delinquency
    // gate, and the self-deal filter. See
    // LUMEN-DOCS/creator-tokens/FINDING-did-case-identity-2026-07-28.md.
    //
    // ★ THE FIX IS METHOD-CONDITIONAL, AND MUST STAY THAT WAY. Normalising every
    // account would CORRUPT Bitcoin identities: base58 (P2PKH/P2SH) is
    // case-sensitive, so case-folding a valid bip122 DID yields a string that is
    // no longer that address. Only the eip155 branch is touched; the bip122
    // branch below preserves case deliberately.
    //
    // No migration is needed: `externalRef` stores the raw address and this DID
    // is derived on every read, and EIP-55 is a pure function of the lowercase
    // hex — so an already-stored lowercase address checksums to the same result.
    return `did:pkh:${EVM_CAIP2}:${checksumEvmAddress(address)}`;
  }
  if (method === 'btc_wallet') {
    const caip2 = network === 'testnet' ? BTC_TESTNET_CAIP2 : BTC_MAINNET_CAIP2;
    // Address case preserved deliberately — see the header note.
    return `did:pkh:bip122:${caip2}:${address}`;
  }
  return null;
}

/** Every wallet identity a user controls. Balances are per-wallet, never merged. */
export function walletDids(
  credentials: { method: AuthMethod; externalRef: string; network: string | null }[]
): WalletDid[] {
  return credentials
    .map((c) => {
      const did = walletDid(c.method, c.externalRef, c.network);
      return did ? { method: c.method, address: c.externalRef, did, network: c.network } : null;
    })
    .filter((d): d is WalletDid => d !== null);
}
