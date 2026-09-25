import { AuthMethod } from '../types';
import { isEvmAddress, normalizeEvmAddress } from '@/blog/lib/lite/auth/evm-verify';
import { normalizeBtcAddress } from '@/blog/lib/lite/auth/btc-verify';

/**
 * The inverse of `./did-pkh.ts`'s `walletDid`: which stored wallet credential a
 * `did:pkh` names, in the exact form `lumen_auth_credential.external_ref` holds it, so
 * (method, external_ref) finds the Lumen account that owns the wallet. A Meritum escrow
 * names its buyer only by `did:pkh`, and this is how messaging reaches that buyer.
 *
 * The case rules are the login routes' own normalisers, so the two cannot disagree:
 * EVM is stored lowercase (the DID carries EIP-55 casing), Bitcoin keeps its case
 * except bech32. The CAIP-2 chain id is not needed: a Bitcoin address already says
 * which network it is on.
 *
 * Kept out of `did-pkh.ts` on purpose: the Bitcoin normaliser's module loads a BIP-322
 * verifier, and `did-pkh.ts` is imported by routes that have no use for it (the bell's
 * notifications among them).
 */
export function walletRefForDid(did: string): { method: AuthMethod; externalRef: string } | null {
  const match = /^did:pkh:([^:]+):[^:]+:(.+)$/.exec(did.trim());
  if (!match) return null;
  const [, namespace, address] = match;
  if (namespace === 'eip155') {
    const ref = normalizeEvmAddress(address);
    return isEvmAddress(ref) ? { method: 'evm_wallet', externalRef: ref } : null;
  }
  if (namespace === 'bip122') {
    const ref = normalizeBtcAddress(address);
    return ref ? { method: 'btc_wallet', externalRef: ref } : null;
  }
  return null;
}
