import { AuthMethod } from '../types';

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
    return `did:pkh:${EVM_CAIP2}:${address.toLowerCase()}`;
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
