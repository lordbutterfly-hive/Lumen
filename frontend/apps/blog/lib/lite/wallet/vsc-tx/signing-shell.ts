/**
 * The signing shell — the exact object a wallet signs when it authorises a Magi
 * transaction.
 *
 * ★ WHY THIS IS THE MOST IMPORTANT FILE IN THE WALLET RAIL.
 *
 * A wallet-signed Magi transaction is verified by the node INDEPENDENTLY
 * reconstructing this shell and hashing it. Nothing is transmitted that says "here
 * is what I signed" — both sides build the same object from the same inputs and the
 * signature either matches or it does not. So this is not serialisation code, it is
 * an interoperability contract with the node, and the failure mode when it drifts
 * is silent: no error, no log, just a signature that will not verify.
 *
 * The contract, verified at source on both sides:
 *
 *   ours:  each op's payload becomes ONE alphabetically-sorted JSON string
 *   node:  modules/transaction-pool/transaction-pool.go:101-131 does the same via
 *          cbornode block.MarshalJSON()
 *
 * ★ THE PARITY IS NOT UNCONDITIONAL. An earlier version of this comment claimed it
 * was; that claim was DISPROVEN by driving identical CBOR bytes through this code
 * and through Go's real path side by side (report:
 * LUMEN-DOCS/creator-tokens/WALLET-IDENTITY-SCRUTINY-2026-07-30.md). Three key
 * shapes serialise differently, and each produces a signature the node cannot
 * verify:
 *
 *   1. NUMERIC-STRING KEYS ("1", "2", "10"). JavaScript reorders integer-like
 *      object keys into numeric order during enumeration — that is spec-mandated
 *      and happens BEFORE our .sort() ever sees them, so it is not fixable here.
 *      JS yields 1,2,10; Go yields 1,10,2 (lexicographic).
 *   2. KEYS OUTSIDE THE BMP (e.g. an emoji). JS compares UTF-16 code units, Go
 *      compares UTF-8 bytes, so a surrogate pair sorts on the wrong side of a
 *      private-use BMP character.
 *   3. AN `undefined` VALUE. `JSON.stringify` silently omits the key; Go decodes
 *      CBOR undefined to null and KEEPS it.
 *
 * All three fail CLOSED — the signature simply does not verify, traced through
 * EthDID.Verify/BtcDID.Verify, which hash the node's own reconstruction. So this is
 * an interop-contract bug, never a fund-loss one. Every payload shape we actually
 * send today (intent args, container headers) uses fixed ASCII keys and so is
 * unaffected. `assertSignableShape` below refuses the three shapes outright rather
 * than letting a user pay resource credits for a signature that cannot verify.
 *
 * Two consequences worth stating out loud, because both have bitten this codebase:
 *
 *  1. Intents — the permission slips that bound what a contract may pull — travel
 *     INSIDE that string as text. That is why the node needed no changes to accept
 *     them, and why every intent value must be a STRING: `JSON.stringify` and Go's
 *     encoder do not agree on every number (large integers, anything exponential),
 *     and a disagreement is an unverifiable signature.
 *  2. Key order in the source is irrelevant — both sides re-sort. Never rely on the
 *     order you happen to write a literal in.
 *
 * Ported from the production implementation in
 * `altera-app/src/lib/magiTransactions/eth/signing_shell.ts`. Deliberately NOT
 * ported from Bitcoin-wrap-UI, whose converter names array indices `[i]` where the
 * node needs `_i_` and therefore can never verify.
 *
 * ★ THE CODEC IS INJECTED. `createSigningShell` needs to decode a CBOR payload, but
 * taking that as a parameter keeps this module dependency-free and therefore
 * unit-testable without a codec, a wallet, or a network. The real decoder is wired
 * at the call site.
 */

/** An operation as it sits in the container: a type tag and a CBOR-encoded payload. */
export interface VscTxOp {
  type: string;
  payload: Uint8Array;
}

/** Headers are signed too — the nonce is what stops a signature being replayed. */
export interface VscTxHeaders {
  nonce: number;
  required_auths: string[];
  rc_limit: number;
  net_id: string;
}

export interface VscTxContainer {
  __t: string;
  __v: string;
  headers: VscTxHeaders;
  tx: VscTxOp[];
}

/** What actually gets hashed: the same shape, with each payload flattened to a string. */
export interface VscTxSigningShell {
  __t: string;
  __v: string;
  headers: VscTxHeaders;
  tx: { type: string; payload: string }[];
}

/** Decodes a CBOR payload back to a plain object. Injected — see the header note. */
export type PayloadDecoder = (payload: Uint8Array) => unknown;

/**
 * Recursively sort object keys alphabetically, leaving array ORDER intact.
 *
 * Array order is meaningful (two intents are not interchangeable to a reader) but
 * each element's keys must still be normalised, or the same logical transaction
 * would hash differently depending on how someone typed it.
 *
 * This mirrors Go's `json.Marshal` for every key shape we send, but NOT for all
 * possible keys — see the three divergences in this file's header. It is a verbatim
 * port of the production implementation; do not "improve" it, and do not try to fix
 * the numeric-key case here, because JavaScript has already reordered those keys
 * before this function is called.
 */
export function sortKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(sortKeys);
  if (typeof obj !== 'object' || obj === null) return obj;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    sorted[key] = sortKeys((obj as Record<string, unknown>)[key]);
  }
  return sorted;
}

/**
 * Build the object to be signed from the container.
 *
 * Headers are copied FIELD BY FIELD rather than spread, on purpose: the set of
 * signed header fields is part of the contract with the node, so adding one has to
 * be a deliberate edit here rather than something that leaks in because a caller
 * attached an extra property to its headers object.
 */
export function createSigningShell(container: VscTxContainer, decode: PayloadDecoder): VscTxSigningShell {
  return {
    __t: container.__t,
    __v: container.__v,
    headers: {
      nonce: container.headers.nonce,
      required_auths: container.headers.required_auths,
      rc_limit: container.headers.rc_limit,
      net_id: container.headers.net_id
    },
    tx: container.tx.map((op) => ({
      type: op.type,
      payload: JSON.stringify(sortKeys(decode(op.payload)))
    }))
  };
}

/**
 * Refuse a payload whose shape cannot be signed reliably.
 *
 * The three divergences in this file's header all end the same way: the wallet
 * produces a signature, the user pays resource credits, the node rebuilds a
 * different string, and verification fails with nothing to explain it. A BigInt
 * value ends worse still — `JSON.stringify` throws from inside the signing call.
 *
 * Every one of those is cheap to detect BEFORE asking anyone to sign, so this
 * refuses loudly and locally instead. It is intentionally strict: none of these
 * shapes is reachable from our own payload builders, so a hit here means either a
 * new payload shape or a bug, and both deserve to stop.
 */
export function assertSignableShape(value: unknown, path = 'payload'): void {
  if (typeof value === 'bigint') {
    throw new Error(
      `${path}: a BigInt cannot be signed — JSON.stringify throws on it, from inside the signing call. Send the value as a decimal STRING.`
    );
  }
  if (value === undefined) {
    throw new Error(
      `${path}: an undefined value cannot be signed — JSON.stringify drops the key while the node decodes it to null and keeps it, so the two sides hash different strings. Omit the field or send null explicitly.`
    );
  }
  // ── Divergences 4-7, added 2026-08-19 ────────────────────────────────────
  // Each was proven by running the node's OWN packages at commit 33adaeb5 and
  // diffing the signed string against this file's algorithm. All fail closed
  // (the signature simply will not verify), and none was guarded before.
  if (typeof value === 'number') {
    // NaN / ±Infinity. Go's json.Marshal REFUSES them, and
    // transaction-pool.go:109 discards that error — so the op's signed payload
    // becomes the EMPTY STRING while JSON.stringify emits `null`. Worse than a
    // mismatch: every NaN-bearing payload collapses to the same signable bytes,
    // so the signature stops binding the payload at all (measured: two different
    // payloads, one signature, both verify). Refuse it here; the node-side fix
    // is theirs to make.
    if (!Number.isFinite(value)) {
      throw new Error(
        `${path}: ${String(value)} cannot be signed — the node's JSON encoder refuses it and (discarding the error) signs an EMPTY payload instead, which also stops the signature binding what you sent. Send a finite number, or a decimal string.`
      );
    }
    // Above 2^53 the JS Number has ALREADY lost the value before stringify runs;
    // the node prints the exact uint64. BigInt is caught above, but a plain
    // lossy Number was not.
    if (!Number.isSafeInteger(value) && Number.isInteger(value)) {
      throw new Error(
        `${path}: the integer ${value} is outside Number.MAX_SAFE_INTEGER — JavaScript has already rounded it, so you would sign a different number than you meant. Send it as a decimal STRING.`
      );
    }
  }
  if (typeof value === 'string') {
    // Go's encoding/json escapes these by default (\u003c, \u003e, \u0026);
    // JSON.stringify does not. This is the likeliest real-world break of the
    // whole set because it hits ordinary CONTENT — a memo, an offering title,
    // any URL carrying a query string.
    const html = /[<>&]/.exec(value);
    if (html) {
      throw new Error(
        `${path}: the character ${JSON.stringify(html[0])} cannot appear in a signed string — the node escapes it as \\u00xx and JavaScript does not, so the two sides hash different bytes. Strip or replace it before signing.`
      );
    }
    // U+2028 / U+2029: same asymmetry, Go escapes and JS emits raw.
    const sep = /[\u2028\u2029]/.exec(value);
    if (sep) {
      throw new Error(
        `${path}: a U+${(sep[0].codePointAt(0) ?? 0).toString(16).toUpperCase()} line/paragraph separator cannot appear in a signed string — the node escapes it and JavaScript does not.`
      );
    }
  }

  if (Array.isArray(value)) {
    value.forEach((v, i) => assertSignableShape(v, `${path}[${i}]`));
    return;
  }
  if (typeof value !== 'object' || value === null) return;

  for (const key of Object.keys(value as Record<string, unknown>)) {
    // Integer-like keys: JavaScript has ALREADY reordered these numerically by the
    // time we see them, and the node sorts them lexicographically. Unfixable here,
    // so refuse it.
    if (/^(0|[1-9][0-9]*)$/.test(key)) {
      throw new Error(
        `${path}.${key}: a numeric-string key cannot be signed — JavaScript enumerates integer-like keys in numeric order while the node sorts them as text, so "10" lands on different sides of "2". Rename the key.`
      );
    }
    // Anything outside the BMP: JS sorts by UTF-16 code unit, Go by UTF-8 byte.
    for (const ch of key) {
      if ((ch.codePointAt(0) ?? 0) > 0xffff) {
        throw new Error(
          `${path}.${key}: a key containing a character outside the Basic Multilingual Plane cannot be signed — JS and the node disagree on where a surrogate pair sorts. Use a BMP-only key.`
        );
      }
    }
    assertSignableShape((value as Record<string, unknown>)[key], `${path}.${key}`);
  }
}
