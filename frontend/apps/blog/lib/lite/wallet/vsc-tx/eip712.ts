/**
 * CBOR → EIP-712 typed data, for signing a Magi transaction with an EVM wallet.
 *
 * WHAT GETS SIGNED. Not the container. The node builds a SIGNING SHELL from it
 * (`VSCTransaction.ToSignableBlock`, crafter.go:660-712): identical envelope
 * and headers, but each `tx[i].payload` is re-emitted as a JSON *string* via
 * `dagNode.MarshalJSON()`. That shell is DAG-CBOR encoded, and those bytes are
 * what this converter turns into typed data. Sign anything else and the
 * signature verifies against a hash the node never computes.
 *
 * ★ WHY THE TYPES ARE DERIVED FROM CBOR BYTES AND NOT FROM THE OBJECT. EIP-712
 * field order is part of the hash. The node's order is whatever DAG-CBOR
 * produced — RFC 7049 canonical, SHORTEST KEY FIRST then bytewise, which is
 * NOT alphabetical (`b`, `c`, `aa` — not `aa`, `b`, `c`). Walking the encoded
 * bytes means the order falls out of the encoder and cannot drift from it.
 * Rebuilding types from a decoded JS object would reintroduce insertion order
 * as a silent variable.
 *
 * ★★ DO NOT PORT FROM `crafter.go`. `VSCTransaction.HashEip712` (crafter.go:713)
 * is the obvious in-repo reference and IT IS WRONG: it sorts type fields
 * alphabetically where the verifier does not (eth.go:939-941, whose own comment
 * reads "else, tests 'sometimes' pass"). It has zero non-test callers. Anyone
 * porting from it produces a hash the node cannot match. This file follows the
 * VERIFIER and the shipped Altera converter instead.
 *
 * ★ EIP712Domain IS DELIBERATELY ABSENT FROM `types`. The build map's first
 * prescription — hand-assemble it and call `provider.request` directly — was
 * wrong twice over. viem does not read `types.EIP712Domain`; it RECOMPUTES the
 * domain separator from `domain`, so Altera's sibling field is dead code that
 * wagmi silently absorbed. Hand-assembling is the riskier path, because it must
 * match what the node re-adds (eth.go:556-561) byte for byte. Let viem derive
 * it from `{name}` alone.
 *
 * Domain is `{name: 'vsc.network'}` ONLY — no chainId, no version, no
 * verifyingContract. Adding any of them changes the domain separator and every
 * signature fails.
 */

import { readCborHead } from './dag-cbor';

/** The node's EIP-712 domain. One field, no chain binding. */
export const VSC_EIP712_DOMAIN = { name: 'vsc.network' } as const;

/** The node's primary type for a transaction container. */
export const VSC_PRIMARY_TYPE = 'tx_container_v0';

export interface Eip712Field {
  name: string;
  type: string;
}

export interface Eip712TypedData {
  domain: { name: string };
  primaryType: string;
  types: Record<string, Eip712Field[]>;
  message: Record<string, unknown>;
}

const EMPTY_ARRAY = Symbol('EMPTY_ARRAY');

type Visitor = (path: string[], value: unknown) => void;

/**
 * Walk DAG-CBOR bytes, calling `visit` for every terminal in ENCOUNTER order,
 * and return the decoded message.
 *
 * Encounter order IS the canonical order, because the bytes were produced by a
 * canonical encoder. That is the whole reason the walk happens over bytes
 * rather than over a decoded object: it makes the EIP-712 field order a
 * property of the encoding rather than of JS object insertion order.
 *
 * ★ AN ARRAY OF OBJECTS BECOMES A MAP KEYED `_0_`, `_1_`, … EIP-712 cannot
 * express an array of structs, so Altera's shipped converter — the one the
 * node is known to accept — rewrites them this way, and the node's verifier
 * expects exactly that. Arrays of SCALARS stay arrays and get a `type[]`.
 *
 * ★ AN EMPTY ARRAY IS VISITED WITH A MARKER AND CONTRIBUTES NO TYPE, matching
 * the node. NOTE this path is UNREACHABLE on this rail, and an earlier version
 * of this comment claimed otherwise: it cited `intents: []` as the common case,
 * but `intents` lives inside the OP BODY, which reaches the shell as a JSON
 * *string* and never as CBOR. The shell only ever holds
 * `{__t, __v, headers{nonce, net_id, rc_limit, required_auths}, tx[{type,
 * payload}]}`, and `buildContainer` refuses an empty `required_auths` or `tx`.
 * Kept for fidelity with the node's converter, not because we hit it.
 *
 * One residual difference, verified with synthetic CBOR and harmless: the node
 * drops an empty array from the MESSAGE entirely, while we keep `[]`. The TYPES
 * agree, so the hash is unaffected.
 */
function walk(bytes: Uint8Array, cursor: { pos: number }, path: string[], visit: Visitor, ignore: boolean): unknown {
  const { major, value } = readCborHead(bytes, cursor);

  // 0 = uint, 2 = bytes, 3 = string, 7 = simple(bool) — all terminal.
  if (major === 0) {
    if (!ignore) visit(path, value);
    return value;
  }
  if (major === 3) {
    const s = new TextDecoder().decode(bytes.subarray(cursor.pos, cursor.pos + value));
    cursor.pos += value;
    if (!ignore) visit(path, s);
    return s;
  }
  if (major === 2) {
    const b = bytes.slice(cursor.pos, cursor.pos + value);
    cursor.pos += value;
    if (!ignore) visit(path, b);
    return b;
  }
  if (major === 7) {
    const b = value === 21;
    if (value !== 20 && value !== 21) throw new Error(`eip712: unsupported simple value ${value}`);
    if (!ignore) visit(path, b);
    return b;
  }

  if (major === 4) {
    const arr: unknown[] = [];
    for (let i = 0; i < value; i++) arr.push(walk(bytes, cursor, [...path, `_${i}_`], visit, ignore));
    if (arr.length === 0 && !ignore) visit(path, EMPTY_ARRAY);
    if (arr.some((v) => typeof v === 'object' && v !== null && !(v instanceof Uint8Array))) {
      const res: Record<string, unknown> = {};
      arr.forEach((v, i) => (res[`_${i}_`] = v));
      return res;
    }
    return arr;
  }

  if (major === 5) {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < value; i++) {
      const k = walk(bytes, cursor, path, visit, true);
      if (typeof k !== 'string') throw new Error(`eip712: non-string map key (${typeof k})`);
      obj[k] = walk(bytes, cursor, [...path, k], visit, ignore);
    }
    return obj;
  }

  throw new Error(`eip712: unsupported major type ${major}`);
}

/**
 * Numbers are `uint256`; everything else keeps its JS type name.
 *
 * ★ TWO LATENT DIVERGENCES FROM THE NODE, both unreachable through the shell's
 * fixed shape and both recorded here so they are not rediscovered as bugs:
 *   - BOOLEAN: the node's converter has no bool visitor and emits NO type and
 *     NO message entry; we emit `{type: 'boolean'}`, which is not even a valid
 *     EIP-712 type name.
 *   - BYTES: the node emits `byte[]` with a base64 string; we emit `object`
 *     with a Uint8Array.
 * The shell contains only strings and unsigned integers, so neither fires. If
 * the shell's shape ever gains a bool or a byte string, fix this FIRST — both
 * are silent hash mismatches, not errors.
 */
function eip712Type(value: unknown): string {
  const t = typeof value;
  if (t === 'number' || t === 'bigint') return 'uint256';
  return t;
}

/**
 * `_12_` is an array index marker; `[]`, `4`, `[two]` are not.
 *
 * ★ DIVERGES FROM THE NODE ON MALFORMED KEYS. We use `parseInt`, which stops at
 * the first non-digit; the node uses `strconv.Atoi`, which rejects the whole
 * string. So `_1x_`, `_0x10_` and `_+1_` are ordinary struct fields to the node
 * and array indices to us — different types, different hash. Unreachable
 * through the shell, whose key set is fixed and generated by us.
 */
function isIndexKey(s: string): boolean {
  if (s.length <= 2) return false;
  if (s.at(0) !== '_' || s.at(-1) !== '_') return false;
  return !Number.isNaN(parseInt(s.slice(1, -1), 10));
}

function pathsEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Convert DAG-CBOR bytes into the typed data the node will verify against.
 *
 * Mirrors the shipped Altera converter (`cbor_to_eip712_converter.ts`), which
 * is the implementation the node is known to accept in production. The nested
 * type names are built by joining the path with `_`, so `tx[0].payload`
 * produces the type `tx_container_v0_tx__0_`.
 */
export function convertCborToEip712TypedData(
  bytes: Uint8Array,
  primaryType: string = VSC_PRIMARY_TYPE,
  domainName: string = VSC_EIP712_DOMAIN.name
): Eip712TypedData {
  const typeMap: { typeName: string[]; val: Eip712Field }[] = [];

  const visit: Visitor = (path, value) => {
    if (typeof value === 'undefined' || typeof value === 'function') {
      throw new Error(`eip712: a CBOR value cannot be ${typeof value}`);
    }
    if (value === null) throw new Error('eip712: a CBOR value cannot be null');
    if (value === EMPTY_ARRAY) return;

    typeMap.push({
      typeName: [primaryType, ...path.slice(0, -1)],
      val: { name: path.at(-1) as string, type: eip712Type(value) }
    });
  };

  const message = walk(bytes, { pos: 0 }, [], visit, false) as Record<string, unknown>;

  const types: Record<string, Eip712Field[]> = {};
  for (const partial of typeMap) {
    for (let i = 0; i < partial.typeName.length; i++) {
      const before = partial.typeName.slice(0, i + 1);
      const after = partial.typeName.slice(i + 1);
      const typeName = before.join('_');

      if (after.length === 0) {
        (types[typeName] ??= []).push(partial.val);
        continue;
      }

      const existing = types[typeName];
      if (existing?.find((t) => t.name === after[0])) continue;

      if (isIndexKey(partial.val.name)) {
        // A scalar array: the field's type is `<elementType>[]`, taken from the
        // first element already recorded under this path.
        const wanted = [...before, after[0]];
        const found = typeMap.find((t) => pathsEqual(t.typeName, wanted));
        if (!found) throw new Error(`eip712: no element type for array ${wanted.join('_')}`);
        types[typeName] = existing || [];
        types[typeName].push({ name: after[0], type: `${found.val.type}[]` });
        break;
      }

      types[typeName] = existing || [];
      types[typeName].push({ name: after[0], type: `${typeName}_${after[0]}` });
    }
  }

  // NOTE: no EIP712Domain entry — viem recomputes it from `domain`. See header.
  return { domain: { name: domainName }, primaryType, types, message };
}

/**
 * The same typed data, shaped for a RAW EIP-1193 provider.
 *
 * ★ THIS IS THE PORT TRAP, AND IT CUTS BOTH WAYS. viem's `signTypedData`
 * RECOMPUTES the domain type from `domain` and ignores any `EIP712Domain` entry
 * — so passing one is pointless there. But `eth_signTypedData_v4` called
 * directly on a wallet provider REQUIRES `types.EIP712Domain` to be present and
 * rejects the payload outright without it. Altera never hit this because it
 * signs through wagmi/viem; this app talks to the AppKit provider directly.
 *
 * The entry added here is byte-identical to what the node re-adds before
 * hashing (`computeEIP712Hash`, eth.go:555-561): one field, `name`, type
 * `string`. Any deviation changes the domain separator and every signature
 * fails verification.
 */
export function toWalletTypedData(td: Eip712TypedData): Eip712TypedData & {
  types: Record<string, Eip712Field[]>;
} {
  return {
    ...td,
    types: { ...td.types, EIP712Domain: [{ name: 'name', type: 'string' }] }
  };
}
