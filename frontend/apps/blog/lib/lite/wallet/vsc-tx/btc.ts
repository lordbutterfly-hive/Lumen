/**
 * Bitcoin wallet signing for Magi transactions.
 *
 * ★★ BTC CANNOT BE REHEARSED ON TESTNET. `dids.Parse` (dids.go:43-53) tries
 * `ParseEthDID` then `ParseBtcDID` — MAINNET ONLY — and never
 * `ParseBtcTestnetDID`, which exists but is referenced only by an address
 * classifier. Every verification helper in btc.go is hardcoded to
 * `chaincfg.MainNetParams`. So a testnet BTC identity cannot be parsed as a DID
 * at all, and THE FIRST BITCOIN TRANSACTION IS REAL MAINNET MONEY. Ship it
 * behind a flag, with a small amount, after the EVM rail has run in anger.
 *
 * ★ BTC SIGNS SOMETHING COMPLETELY DIFFERENT FROM EVM. The EVM rail signs
 * EIP-712 typed data built from the shell's CBOR. Bitcoin signs the shell's
 * **CID STRING** as a plain Bitcoin Signed Message (btc.go:135). The user is
 * shown an opaque `bafyrei…` in their wallet. Nothing can make that legible
 * without a node change, so the UI must explain it rather than hide it.
 *
 * ★ TWO SIGNATURE FORMATS, CHOSEN BY LENGTH (btc.go:119-129):
 *   - 65 bytes  → BIP-137 compact, valid for p2pkh / p2sh / p2wpkh
 *   - otherwise → BIP-322 simple, accepted ONLY for p2wpkh
 * Taproot (`bc1p`) is refused at DID parse (btc.go:52) and is already blocked
 * at connect time in appkit.ts. Keep that block and SAY WHY in the UI: Xverse,
 * Unisat, OKX and Phantom all present a taproot address prominently, so a user
 * will pick one unless told not to.
 */

import { dagCborCid } from './cid';

/** What a Bitcoin wallet is asked to sign: the signing shell's CID string. */
export async function btcSigningMessage(shellBytes: Uint8Array): Promise<string> {
  return dagCborCid(shellBytes);
}

/**
 * Rewrite a BIP-137 recovery header into the range Go will accept.
 *
 * ★ THE PROBLEM. Go's `ecdsa.RecoverCompact` accepts recovery bytes only in
 * [27, 34] — the legacy P2PKH range. Real SegWit wallets do not emit those:
 * P2SH-P2WPKH emits 35-38 and native P2WPKH emits 39-42. The signature is
 * cryptographically fine; only the header byte is outside what the verifier
 * will parse, so it fails as "failed to recover public key" and looks like a
 * broken wallet.
 *
 * ★★ NEVER APPLY THIS TO THE LOGIN VERIFIER. `lib/lite/auth/btc-verify.ts`
 * verifies an ownership proof, and normalising a header there would accept a
 * signature the wallet did not make in the form it claimed. Normalise for a
 * TRANSACTION, never for a login. The two paths are deliberately separate
 * files for exactly this reason.
 */
export function normalizeBip137Header(sigBase64: string): string {
  const bytes = base64ToBytes(sigBase64);
  if (bytes.length !== 65) return sigBase64; // BIP-322: pass through untouched.

  const header = bytes[0];
  let normalized = header;
  if (header >= 35 && header <= 38) normalized = header - 4; // P2SH-P2WPKH
  else if (header >= 39 && header <= 42) normalized = header - 8; // native P2WPKH
  if (normalized === header) return sigBase64;

  const out = Uint8Array.from(bytes);
  out[0] = normalized;
  return bytesToBase64(out);
}

/**
 * Refuse a signature the node will certainly reject, before it costs a nonce.
 *
 * The high-S check mirrors the node's own (btc.go:141-146): a 65-byte compact
 * signature is [header|R|S] and the verifier rejects the high-S form outright,
 * so catching it here turns a mystery refusal into a sentence.
 */
export function assertBtcSignature(sigBase64: string, addressType: 'p2pkh' | 'p2sh' | 'p2wpkh'): void {
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(sigBase64);
  } catch {
    throw new Error('btc: the wallet returned a signature that is not valid base64');
  }

  if (bytes.length !== 65) {
    if (addressType !== 'p2wpkh') {
      throw new Error(
        `btc: a ${addressType} address can only use a 65-byte BIP-137 signature; BIP-322 is accepted ` +
          'only for native segwit (bc1q) addresses.'
      );
    }
    return; // BIP-322 simple, variable length.
  }

  const header = bytes[0];
  if (header < 27 || header > 42) {
    throw new Error(`btc: unrecognised BIP-137 recovery header ${header}`);
  }

  // ★ THE HIGH-S CHECK, WHICH THIS FUNCTION USED TO ONLY CLAIM TO DO. The
  // comment above described mirroring the node's canonical-S rule while the
  // body did not implement it (adversarial review, 2026-08-20), so a high-S
  // wallet signature passed our gate, cost the user a wallet prompt and a
  // submit, and was refused by the node with "non-canonical signature". A
  // compact signature is [header|R|S]; the node requires 0 < S <= N/2
  // (btc.go:139-146) so that one (key, message) has exactly one valid encoding.
  const s = bytesToBigInt(bytes.subarray(33, 65));
  if (s <= 0n || s > SECP256K1_HALF_ORDER) {
    throw new Error(
      'btc: this wallet produced a non-canonical (high-S) signature, which the node refuses. Signing again usually yields a canonical one.'
    );
  }
  if (header > 34) {
    throw new Error(
      `btc: recovery header ${header} must be normalised before submission — call normalizeBip137Header.`
    );
  }
}

/** secp256k1 group order N, halved — the canonical-S ceiling (btc.go). */
const SECP256K1_HALF_ORDER =
  0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

function bytesToBigInt(bytes: Uint8Array): bigint {
  let out = 0n;
  for (const b of bytes) out = (out << 8n) | BigInt(b);
  return out;
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return typeof btoa === 'function' ? btoa(binary) : Buffer.from(bytes).toString('base64');
}
