/**
 * DAG-CBOR encode/decode for the Magi transaction container.
 *
 * WHY IN-REPO RATHER THAN `@ipld/dag-cbor`. Two reasons, and the second is the
 * one that decided it:
 *
 *  1. Both `@ipld/dag-cbor` and `cborg` are ESM-only with no CJS entry point.
 *     Next.js bundles them fine, but every selftest in this app runs under
 *     `npx tsx` on Node 20, which cannot `require()` an ESM package. Adding
 *     them would have made the signing rail the one part of this codebase that
 *     cannot be tested the way everything else is tested — for a serialization
 *     format where byte-exactness IS the correctness condition.
 *
 *  2. The canonical ORDERING is the single most dangerous detail in this build,
 *     and it should be explicit in code we own rather than an emergent property
 *     of a transitive dependency's default options.
 *
 * ★ THE ORDERING RULE: RFC 7049 canonical, which go-ipld-prime calls
 * `MapSortMode_RFC7049` (dagcbor/marshal.go:209-217). Keys sort by ENCODED
 * LENGTH FIRST, then bytewise. So `b`, `c`, `aa` — NOT alphabetical `aa`, `b`,
 * `c`. Getting this wrong produces a signature the node cannot verify, with no
 * error that points at ordering.
 *
 * ★ THIS IS NOT A GENERAL CBOR LIBRARY. It covers exactly the value domain a
 * Magi container contains: maps with string keys, arrays, strings, unsigned
 * integers, byte strings, and booleans. Anything else THROWS rather than
 * guessing — floats, negatives, null and undefined are all refused, because
 * each of them is a case where JS and Go disagree and a silent encode would
 * produce an unverifiable signature. The container has no legitimate use for
 * any of them.
 *
 * ★ ONE DELIBERATE DIFFERENCE FROM `common.EncodeDagCbor`, and it is safe.
 * The node's helper runs values through `json.Marshal` first, so a Go `[]byte`
 * arrives as a base64 TEXT string; we emit a real CBOR byte string. The two are
 * not byte-identical for that one type. It does not matter on this rail:
 * `IngestTx` decodes with `common.DecodeCbor`, which round-trips both forms to
 * the same `[]byte`, and 43 end-to-end containers verified against the node's
 * real verifier with our form. Byte-equality holds for every other type.
 *
 * Byte-equality against go-ipld-prime was verified by diffing 43 encoder
 * vectors against the node's own `common.EncodeDagCbor` output.
 */

const MAJOR_UINT = 0;
const MAJOR_BYTES = 2;
const MAJOR_STRING = 3;
const MAJOR_ARRAY = 4;
const MAJOR_MAP = 5;
const MAJOR_SIMPLE = 7;

function encodeHead(major: number, length: number, out: number[]): void {
  if (length < 24) {
    out.push((major << 5) | length);
  } else if (length < 0x100) {
    out.push((major << 5) | 24, length);
  } else if (length < 0x10000) {
    out.push((major << 5) | 25, length >> 8, length & 0xff);
  } else if (length < 0x100000000) {
    out.push((major << 5) | 26, (length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff);
  } else {
    // CBOR minor 27 (8-byte head) is legal and go-ipld-prime emits it, but
    // nothing this rail builds reaches it: a nonce, an rc_limit or a length
    // would all have to exceed 2^32. Refusing keeps the encoder total, and it
    // fails at BUILD time — before any wallet prompt — rather than producing
    // bytes the node would read differently.
    throw new Error(
      `dag-cbor: ${length} needs a 64-bit CBOR head (minor 27), which this encoder does not emit`
    );
  }
}

const utf8 = new TextEncoder();

/**
 * RFC 7049 canonical key order: shorter encoded key first, then bytewise.
 * Compared on UTF-8 BYTES, not UTF-16 code units, so a non-ASCII key sorts the
 * same way Go sorts it.
 */
function rfc7049KeyCompare(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return a.length - b.length;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function encodeValue(value: unknown, out: number[], path: string): void {
  if (typeof value === 'string') {
    const bytes = utf8.encode(value);
    encodeHead(MAJOR_STRING, bytes.length, out);
    for (const b of bytes) out.push(b);
    return;
  }

  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new Error(`dag-cbor: ${path} is not an integer (${value}) — floats are refused`);
    }
    if (value < 0) {
      throw new Error(`dag-cbor: ${path} is negative (${value}) — the container has no negative fields`);
    }
    if (!Number.isSafeInteger(value)) {
      throw new Error(`dag-cbor: ${path} is outside Number.MAX_SAFE_INTEGER — it has already lost precision`);
    }
    encodeHead(MAJOR_UINT, value, out);
    return;
  }

  if (typeof value === 'boolean') {
    out.push((MAJOR_SIMPLE << 5) | (value ? 21 : 20));
    return;
  }

  if (value instanceof Uint8Array) {
    encodeHead(MAJOR_BYTES, value.length, out);
    for (const b of value) out.push(b);
    return;
  }

  if (Array.isArray(value)) {
    encodeHead(MAJOR_ARRAY, value.length, out);
    value.forEach((v, i) => encodeValue(v, out, `${path}[${i}]`));
    return;
  }

  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([k, v]) => ({ keyBytes: utf8.encode(k), key: k, val: v })
    );
    entries.sort((x, y) => rfc7049KeyCompare(x.keyBytes, y.keyBytes));
    encodeHead(MAJOR_MAP, entries.length, out);
    for (const e of entries) {
      encodeHead(MAJOR_STRING, e.keyBytes.length, out);
      for (const b of e.keyBytes) out.push(b);
      encodeValue(e.val, out, `${path}.${e.key}`);
    }
    return;
  }

  if (value === null) throw new Error(`dag-cbor: ${path} is null — refused, Go and JS disagree on it`);
  throw new Error(`dag-cbor: ${path} has unsupported type ${typeof value}`);
}

/** DAG-CBOR encode. Map keys are emitted in RFC 7049 canonical order. */
export function encodeDagCbor(value: unknown): Uint8Array {
  const out: number[] = [];
  encodeValue(value, out, 'root');
  return Uint8Array.from(out);
}

interface Cursor {
  pos: number;
}

/**
 * Read one CBOR head. Exported because the EIP-712 converter needs to walk the
 * same bytes with a visitor, and duplicating the head decoding there would be
 * two implementations of the one thing that must not disagree.
 */
export function readCborHead(bytes: Uint8Array, c: { pos: number }): { major: number; value: number } {
  return readHead(bytes, c);
}

function readHead(bytes: Uint8Array, c: Cursor): { major: number; value: number } {
  const b = bytes[c.pos++];
  const major = b >> 5;
  const minor = b & 31;
  if (minor < 24) return { major, value: minor };
  if (minor === 24) return { major, value: bytes[c.pos++] };
  if (minor === 25) {
    const v = (bytes[c.pos] << 8) | bytes[c.pos + 1];
    c.pos += 2;
    return { major, value: v };
  }
  if (minor === 26) {
    const v =
      bytes[c.pos] * 0x1000000 + (bytes[c.pos + 1] << 16) + (bytes[c.pos + 2] << 8) + bytes[c.pos + 3];
    c.pos += 4;
    return { major, value: v };
  }
  // Minor 27 is the 8-byte head. See encodeHead: symmetric, deliberate gap.
  throw new Error(
    `dag-cbor: additional-info ${minor} (64-bit head) is not decoded by this codec`
  );
}

const utf8Decoder = new TextDecoder();

function decodeValue(bytes: Uint8Array, c: Cursor): unknown {
  const { major, value } = readHead(bytes, c);
  switch (major) {
    case MAJOR_UINT:
      return value;
    case MAJOR_BYTES: {
      const out = bytes.slice(c.pos, c.pos + value);
      c.pos += value;
      return out;
    }
    case MAJOR_STRING: {
      const out = utf8Decoder.decode(bytes.subarray(c.pos, c.pos + value));
      c.pos += value;
      return out;
    }
    case MAJOR_ARRAY: {
      const arr: unknown[] = [];
      for (let i = 0; i < value; i++) arr.push(decodeValue(bytes, c));
      return arr;
    }
    case MAJOR_MAP: {
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < value; i++) {
        const k = decodeValue(bytes, c);
        if (typeof k !== 'string') throw new Error('dag-cbor: non-string map key');
        obj[k] = decodeValue(bytes, c);
      }
      return obj;
    }
    case MAJOR_SIMPLE:
      if (value === 20) return false;
      if (value === 21) return true;
      throw new Error(`dag-cbor: unsupported simple value ${value}`);
    default:
      throw new Error(`dag-cbor: unsupported major type ${major}`);
  }
}

/** DAG-CBOR decode, for the value domain `encodeDagCbor` produces. */
export function decodeDagCbor(bytes: Uint8Array): unknown {
  const c: Cursor = { pos: 0 };
  const value = decodeValue(bytes, c);
  if (c.pos !== bytes.length) {
    throw new Error(`dag-cbor: ${bytes.length - c.pos} trailing byte(s) after the top-level value`);
  }
  return value;
}
