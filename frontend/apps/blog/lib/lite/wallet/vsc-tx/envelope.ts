/**
 * The signature envelope submitted as `sig` to `submitTransactionV1`.
 *
 * Shape: `{__t: 'vsc-sig', sigs: [{alg, sig, kid}]}`, DAG-CBOR encoded then
 * base64. The node accepts standard and url-safe base64, padded or raw
 * (gql/gqlgen/base64.go:16-26), so plain base64 is fine.
 *
 * ★ `alg` AND `kid` ARE IGNORED FOR `did:pkh`. Proven on the node by verifying
 * a signature carrying `alg: "TOTALLY-BOGUS"` and a zero-address `kid` — it
 * passed. They are load-bearing only for `did:vsc:` (BLS) signatures. They are
 * still populated honestly here: a field the current verifier ignores is
 * exactly the kind of thing a later version starts checking, and a lie stored
 * now becomes a breakage later for no benefit today.
 *
 * ★★ THE MAPPING TO `required_auths` IS POSITIONAL, NEVER BY `kid`. `sigs[i]`
 * authorises `required_auths[i]`, and `len(sigs)` must equal
 * `len(required_auths)` EXACTLY. This is the trap in multi-auth transactions:
 * a correct signature in the wrong slot fails, and it fails as "signature
 * invalid" with no hint that ordering was the problem.
 */

import { encodeDagCbor } from './dag-cbor';

import { toBase64 } from './container';

export interface VscSig {
  alg: string;
  sig: string;
  kid: string;
}

export interface VscSigEnvelope {
  __t: 'vsc-sig';
  sigs: VscSig[];
}

/** EIP-191/712 secp256k1 over keccak — what an EVM wallet produces. */
export const ALG_EIP712 = 'eth-eip712';
/** A BIP-137 signed message — what a BTC wallet produces. */
export const ALG_BIP137 = 'btc-bip137';

/**
 * Build the envelope. `sigs` must be in the SAME ORDER as the container's
 * `required_auths` — see the positional note above.
 */
export function buildSigEnvelope(sigs: readonly VscSig[]): VscSigEnvelope {
  if (sigs.length === 0) {
    throw new Error('envelope: at least one signature is required');
  }
  return { __t: 'vsc-sig', sigs: [...sigs] };
}

/**
 * Refuse an envelope that cannot match its container.
 *
 * The count check is the whole point: it is the one mismatch the node reports
 * indistinguishably from a genuinely bad signature, so catching it here turns
 * a mystery into a sentence.
 */
export function assertEnvelopeMatchesAuths(
  envelope: VscSigEnvelope,
  requiredAuths: readonly string[]
): void {
  if (envelope.sigs.length !== requiredAuths.length) {
    throw new Error(
      `envelope: ${envelope.sigs.length} signature(s) for ${requiredAuths.length} required_auths — ` +
        'the node maps them POSITIONALLY and requires exactly one signature per auth.'
    );
  }
}

/** DAG-CBOR + base64, ready for the `sig` GraphQL argument. */
export function serializeSigEnvelope(envelope: VscSigEnvelope): string {
  return toBase64(encodeDagCbor(envelope));
}

/**
 * An EVM signature must be 0x-prefixed and exactly 65 bytes. The node
 * auto-normalises `v` between 27/28 and 0/1, so both conventions are accepted
 * — but a truncated or non-hex signature is refused here rather than being
 * submitted and burning a nonce slot for nothing.
 */
export function assertEvmSignature(sig: string): void {
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) {
    throw new Error(
      `envelope: an EVM signature must be 0x + 130 hex characters (65 bytes), got ${sig.length} chars`
    );
  }
}
