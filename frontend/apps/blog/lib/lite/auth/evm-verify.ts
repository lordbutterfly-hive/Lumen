import { createHash } from 'crypto';
import { getAddress, isAddress, recoverMessageAddress, type Hex } from 'viem';

/**
 * EVM login proof verification — the third lite auth method, mirroring btc-verify.
 *
 * The wallet signs our single-use nonce with EIP-191 `personal_sign` (what every
 * injected wallet and every WalletConnect/Reown `eip155` session exposes). We
 * recover the signer and compare it to the claimed address.
 *
 * NOT to be confused with `packages/smart-signer/lib/signer/signer-metamask.ts`:
 * that one drives MetaMask's HIVE Snap and produces a real Hive account. This
 * module never touches Hive keys — an EVM address is an identity binder only.
 *
 * A personal_sign proof carries no chain id, so it is chain-agnostic on purpose:
 * the same key owns the address on Ethereum, Base, Arbitrum, Magi's EVM, etc.
 *
 * Smart-contract wallets (EIP-1271 / EIP-6492) are NOT accepted: verifying them
 * needs an RPC call per chain, and a contract's "owner" can change, which would
 * quietly transfer a Lumen account. EOAs only until that is designed properly.
 */

/** 65-byte r||s||v signature, hex. */
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;

const ZERO = '0x0000000000000000000000000000000000000000';

/** The exact string the wallet signs to LOG IN. Issuance and verify share it. */
export function loginMessage(nonce: string): string {
  return [
    'Lumen sign-in',
    '',
    'Sign this to prove you control this wallet.',
    'It authorizes no transaction and moves no funds.',
    '',
    `Nonce: ${nonce}`
  ].join('\n');
}

/**
 * The string a wallet signs to LINK (bind) an address to an already-signed-in
 * account — deliberately DISTINCT from loginMessage so a sign-in signature can
 * never be replayed as a bind proof, and the wallet shows the user they are
 * linking rather than logging in (SEQ-1, PRUNED 2026-07-22).
 */
export function bindMessage(nonce: string): string {
  return [
    'Lumen link wallet',
    '',
    'Sign this to link this wallet to your existing Lumen account.',
    'It authorizes no transaction and moves no funds.',
    '',
    `Nonce: ${nonce}`
  ].join('\n');
}

/**
 * Stable hash of a normalized address — stored as a login challenge's
 * `payload_hash` so a challenge issued for one address cannot be consumed with a
 * different address (SEQ-1). Not secret; just a binding. Same construction as the
 * BTC path, and the address formats cannot collide.
 */
export function addressChallengeHash(address: string): string {
  return createHash('sha256').update(normalizeEvmAddress(address)).digest('hex');
}

/** Storage form of an address: lowercase hex — the `external_ref` we key on. */
export function normalizeEvmAddress(address: string): string {
  return address.trim().toLowerCase();
}

/** Display form: EIP-55 checksummed. Throws on a malformed address. */
export function checksumEvmAddress(address: string): string {
  return getAddress(address.trim());
}

/** Shape check only — no signature involved. */
export function isEvmAddress(address: string): boolean {
  const a = address.trim();
  return isAddress(a) && a.toLowerCase() !== ZERO;
}

/** Coarse network label for the credential row (informational; see header). */
export function evmNetwork(): string {
  return 'eip155';
}

export interface EvmVerifyInput {
  address: string;
  message: string;
  /** 0x-prefixed 65-byte signature from personal_sign / eth_sign. */
  signature: string;
}

export async function verifyEvmSignature(input: EvmVerifyInput): Promise<boolean> {
  if (!isEvmAddress(input.address)) return false;
  if (!SIGNATURE.test(input.signature.trim())) return false;
  try {
    const recovered = await recoverMessageAddress({
      message: input.message,
      signature: input.signature.trim() as Hex
    });
    return recovered.toLowerCase() === normalizeEvmAddress(input.address);
  } catch {
    // Malformed signature/recovery param throws; a failed proof is never a 500.
    return false;
  }
}
