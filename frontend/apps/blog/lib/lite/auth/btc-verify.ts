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
  // Case-folded only for bech32; base58 case is significant (see normalizeBtcAddress).
  return createHash('sha256').update(normalizeBtcAddress(address)).digest('hex');
}

/**
 * Storage/lookup form of a BTC address.
 *
 * Only bech32 may be lowercased (BIP-173 defines it as case-insensitive). Legacy and
 * P2SH addresses are base58, where upper and lower case are DISTINCT symbols, so
 * lowercasing them stores a string that is not the user's real address — and in
 * principle lets two different addresses collide on one key. Fixed 2026-07-28.
 */
export function normalizeBtcAddress(address: string): string {
  const trimmed = address.trim();
  return /^(bc1|tb1|bcrt1)/i.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

export function isTaproot(address: string): boolean {
  return TAPROOT.test(address.trim());
}

/**
 * ════ THE ONLY BITCOIN ADDRESSES MAGI CAN EVER VERIFY ════
 *
 * ★★★ THIS IS A MONEY-LOSS GUARD, NOT A VALIDATION NICETY.
 *
 * A Bitcoin identity that Magi cannot verify a signature for can still be CREDITED
 * creator tokens - the ledger passes through any `did:`-prefixed destination and the
 * token balance key is an arbitrary string. So the account funds normally and can then
 * never move anything, by anyone, forever. Two independent reads of `go-vsc-node`
 * (@ 33adaeb5) found the cause:
 *
 *   - `dids.Parse` (lib/dids/dids.go:31-57) calls ParseBlsDID / ParseEthDID / ParseBtcDID
 *     and **never ParseBtcTestnetDID**. That function exists, is correct, and is reachable
 *     only from the read-only `verify_address` hostcall and the mapping-bot - never from
 *     any signature-verification path, on any network.
 *   - Every address derivation in the verifier decodes against `chaincfg.MainNetParams`
 *     (btc.go:159/178/187/226/238/441), so a testnet string cannot match even if it got
 *     there.
 *   - There is zero test coverage for testnet DIDs in lib/dids.
 *
 * ★ IT IS AN ALLOWLIST BECAUSE A BLOCKLIST ALREADY FAILED HERE. `btcNetwork()` below
 * detects testnet by `tb1|m|n|2`, which a regtest `bcrt1…` address does not match - so
 * regtest was labelled MAINNET, given the mainnet CAIP-2, and then rejected by
 * ParseBtcDID against MainNetParams. Same outcome, opposite path: creditable, unsignable.
 * Enumerating what Magi ACCEPTS cannot fail that way; enumerating what it rejects can.
 *
 * Accepted: mainnet P2PKH (`1…`), P2SH / P2SH-P2WPKH (`3…`), P2WPKH (`bc1q…`).
 * Refused: everything else, including Taproot (`bc1p`), which the verifier also declines
 * (btc.go:51-53, 125-129) and which `isTaproot` already refuses separately.
 */
export function isMagiSignableBtcAddress(address: string): boolean {
  const a = address.trim();
  if (!a || isTaproot(a)) return false;
  // Bech32 mainnet v0 witness program. `bc1q` only - `bc1p` is Taproot, and `tb1`/`bcrt1`
  // are other networks.
  if (/^bc1q[02-9ac-hj-np-z]+$/i.test(a)) return true;
  // Base58 mainnet: version byte 0x00 renders as `1…`, 0x05 as `3…`. Testnet/regtest use
  // `m`, `n` and `2`, which this deliberately does not match.
  if (/^[13][1-9A-HJ-NP-Za-km-z]{25,39}$/.test(a)) return true;
  return false;
}

/** Coarse network label for the credential row (informational). */
export function btcNetwork(address: string): string {
  const a = address.trim().toLowerCase();
  if (a.startsWith('tb1') || a.startsWith('m') || a.startsWith('n') || a.startsWith('2')) {
    return 'testnet';
  }
  return 'bitcoin';
}

/**
 * The bitcoinjs-lib network KEY for an address (F-L29 / F-L36 H-K). Distinct from
 * btcNetwork() above, which returns our CAIP-ish string and folds regtest into
 * 'bitcoin' — wrong for sibling derivation. Only bech32 `bcrt1` vs `tb1`
 * distinguishes regtest from testnet (base58 regtest shares testnet's m/n/2 version
 * bytes, so those map to 'testnet' and yield identical siblings — harmless).
 */
export function btcNetworkKind(address: string): 'bitcoin' | 'testnet' | 'regtest' {
  const a = address.trim().toLowerCase();
  if (a.startsWith('bcrt1')) return 'regtest';
  if (a.startsWith('tb1') || a.startsWith('m') || a.startsWith('n') || a.startsWith('2')) return 'testnet';
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
