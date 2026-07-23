import { createHash } from 'crypto';
import { Verifier } from 'bip322-js';

/**
 * BTC login proof verification (spec §A.4). Altera's wallet signs a message via
 * the AppKit `bip122` provider: SegWit -> BIP-322 simple, legacy -> BIP-137
 * compact. `Verifier.verifySignature` handles both formats. Altera's BTC auth
 * is connect-only; we ADD the signed-nonce challenge here.
 *
 * Taproot (bc1p/tb1p) is rejected to match Altera's AppKit layer.
 */

const TAPROOT = /^(bc1p|tb1p)/i;

/** The exact string the wallet signs. Both challenge issuance and verify use it. */
export function loginMessage(nonce: string): string {
  return `Lumen sign-in: ${nonce}`;
}

/**
 * The message a wallet signs to LINK (bind) an address to an already-signed-in
 * account — deliberately DISTINCT from loginMessage so a sign-in signature can
 * never be replayed as a bind proof, and the wallet shows the user they are
 * linking, not logging in (SEQ-1, PRUNED 2026-07-22).
 */
export function bindMessage(nonce: string): string {
  return `Lumen link account: ${nonce}`;
}

/**
 * Stable hash of a normalized address — stored as a login challenge's
 * `payload_hash` so a challenge issued for one address cannot be consumed with a
 * different address (SEQ-1). Not secret; just a binding.
 */
export function addressChallengeHash(address: string): string {
  return createHash('sha256').update(address.trim().toLowerCase()).digest('hex');
}

export function isTaproot(address: string): boolean {
  return TAPROOT.test(address.trim());
}

/** Coarse network label for the credential row (informational). */
export function btcNetwork(address: string): string {
  const a = address.trim().toLowerCase();
  if (a.startsWith('tb1') || a.startsWith('m') || a.startsWith('n') || a.startsWith('2')) {
    return 'testnet';
  }
  return 'bitcoin';
}

export interface BtcVerifyInput {
  address: string;
  message: string;
  signatureBase64: string;
}

export function verifyBtcSignature(input: BtcVerifyInput): boolean {
  if (isTaproot(input.address)) return false;
  try {
    return Verifier.verifySignature(input.address.trim(), input.message, input.signatureBase64);
  } catch {
    // Malformed signature/address throws; treat as a failed proof, never a 500.
    return false;
  }
}
