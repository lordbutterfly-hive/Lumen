/**
 * The native Magi transaction container — the wallet-signed rail.
 *
 * This is the transport a `did:pkh` identity uses. It is NOT the Hive rail:
 * there is no custom_json, no Hive account, no active key. The container is
 * DAG-CBOR encoded, signed as EIP-712 typed data (EVM) or a BIP-137 message
 * (BTC), and handed to `submitTransactionV1`.
 *
 * ★ EVERY FIELD PLACEMENT BELOW WAS READ OFF THE NODE, NOT INFERRED. The build
 * map's first draft got two of them wrong and both are SILENT failures — the
 * wallet signs happily, the node rebuilds a different shell, and verification
 * fails with nothing to explain it:
 *
 *   - `contract_id` belongs in the OP BODY and was missing from the draft
 *     entirely (crafter.go:465-475).
 *   - `net_id` belongs in the HEADERS ONLY. `VscContractCall.NetId` is
 *     `json:"-"` — deliberately excluded from the offchain payload, because it
 *     is only in the body on the Hive custom_json rail. Lumen's existing
 *     `buildOp` puts it in the body (op-builders.ts:118); copying that here
 *     would be an instant, invisible signature mismatch.
 *   - `caller` and `intents` are in the OP BODY, `required_auths` in the
 *     HEADERS. They look interchangeable and are not.
 *
 * ★ THE PAYLOAD IS DOUBLE-ENCODED. `VscContractCall.Payload` is a *string*
 * whose content is the JSON of the action arguments. The node unescapes
 * exactly one layer before handing it to WASM (transactions.go:161-171). A
 * caller that puts an object there produces a contract that reads its argument
 * as `[object Object]`.
 *
 * ★ TWO ORDER-SENSITIVE LAYERS, TWO DIFFERENT RULES — the single most
 * dangerous thing in this build:
 *   - the CONTAINER and every CBOR body: DAG-CBOR canonical, RFC 7049
 *     LENGTH-FIRST then bytewise (go-ipld-prime MapSortMode_RFC7049). This
 *     falls out of the encoder — never hand-write it.
 *   - the SIGNING SHELL's `tx[i].payload` string: plain LEXICOGRAPHIC, because
 *     the node rebuilds it with `dagNode.MarshalJSON()` → Go `encoding/json`,
 *     which sorts map keys bytewise (crafter.go:660-676).
 * Applying one rule to both layers is a silent unverifiable signature. The
 * shell's sorting lives in `signing-shell.ts` (`sortKeys`) and is already the
 * right algorithm; this file must not re-sort anything.
 */

import { encodeDagCbor } from './dag-cbor';

import { assertIntentsShape, type Intent } from './intents';
import { assertSignableShape } from './signing-shell';

/** Mirrors `transactionpool.VSCTransactionHeader`. */
export interface ContainerHeaders {
  nonce: number;
  required_auths: string[];
  rc_limit: number;
  net_id: string;
}

/** Mirrors `transactionpool.VSCTransactionOp` — payload is CBOR bytes. */
export interface ContainerOp {
  type: string;
  payload: Uint8Array;
}

/** Mirrors `transactionpool.VSCTransactionShell`. */
export interface Container {
  __t: 'vsc-tx';
  __v: '0.2';
  headers: ContainerHeaders;
  tx: ContainerOp[];
}

/** Mirrors `transactionpool.VscContractCall` — the decoded op body. */
export interface CallOpBody {
  contract_id: string;
  action: string;
  payload: string;
  rc_limit: number;
  intents: Intent[];
  caller: string;
}

/**
 * The node's own default when `rc_limit` is 0 (crafter.go:641-644). Stated here
 * so a caller can see what "unset" actually costs rather than discovering it.
 */
export const NODE_DEFAULT_RC_LIMIT = 500;

/** The node's own ingest ceiling (transaction-pool.go:60). */
export const MAX_TX_BYTES = 16_384;

export interface BuildCallOpInput {
  contractId: string;
  action: string;
  /** The action arguments. Serialised to a JSON string — see the double-encode note. */
  payload: Record<string, unknown>;
  rcLimit: number;
  intents?: readonly Intent[];
  /** The DID that authorises this call. Must also appear in `required_auths`. */
  caller: string;
}

/**
 * Build one call op body and CBOR-encode it.
 *
 * `assertSignableShape` runs on the ARGUMENTS here, unconditionally. The
 * existing Hive rail only checks in dev (`buildOp`), which means the one
 * environment where a bad shape costs real money is the one that never looks.
 * Checking before the JSON string is built also means the error names the
 * offending field rather than surfacing as a node-side decode failure.
 */
export function buildCallOp(input: BuildCallOpInput): ContainerOp {
  const intents = input.intents ?? [];
  assertSignableShape(input.payload, 'payload');
  assertIntentsShape(intents);

  if (!input.caller || typeof input.caller !== 'string') {
    throw new Error('container: caller must be a non-empty account or DID string');
  }
  if (!Number.isInteger(input.rcLimit) || input.rcLimit < 0) {
    throw new Error(`container: rc_limit must be a non-negative integer, got ${input.rcLimit}`);
  }
  // ★ THE BODY AND THE HEADERS MUST CARRY THE SAME rc_limit, and they used to
  // be able to disagree. `buildContainer` defaults a non-positive value to
  // NODE_DEFAULT_RC_LIMIT for the HEADERS, while this function wrote the raw
  // value into the signed BODY. The node reads them from different places:
  // admission and the RC-availability check use the HEADER
  // (transaction-pool.go:214), but execution takes the contract's gas ceiling
  // from the BODY (`gas := min(availableGas, t.RcLimit)`,
  // state-processing/transactions.go:112).
  //
  // So `rcLimit: 0` produced a transaction that was ADMITTED on a header of 500,
  // charged the caller RC, consumed a nonce slot, and then executed with ZERO
  // GAS — a guaranteed silent failure on every wallet write, for every user,
  // until someone noticed. Reachable today: `CREATOR_TOKENS_RC_LIMIT=0` survives
  // `opts.rcLimit ?? DEFAULT_RC_LIMIT`, because `??` does not catch 0.
  // (Audit A1, F1, 2026-08-20.)
  if (input.rcLimit === 0) {
    throw new Error(
      'container: rc_limit 0 would be admitted on the header default (500) and then execute with zero ' +
        'gas, failing silently after charging RC. Pass a positive rc_limit, or omit it at the caller.'
    );
  }

  const body: CallOpBody = {
    contract_id: input.contractId,
    action: input.action,
    // Double-encoded, per transactions.go:161-171. The inner JSON's key order
    // is irrelevant HERE (the node re-derives the signing string from the CBOR
    // it decodes), but the string must be exactly what the contract will read.
    payload: JSON.stringify(input.payload),
    rc_limit: input.rcLimit,
    intents: intents as Intent[],
    caller: input.caller
  };

  return { type: 'call', payload: encodeDagCbor(body) };
}

export interface BuildContainerInput {
  netId: string;
  nonce: number;
  rcLimit: number;
  requiredAuths: string[];
  ops: ContainerOp[];
}

/**
 * Assemble the container.
 *
 * `required_auths` is a SET on the node — `ToShell` builds it from a
 * `map[string]bool`, so duplicates collapse. It is deduplicated here for the
 * same reason the node does it, and because `len(sigs)` must equal
 * `len(required_auths)` EXACTLY: a duplicated auth would demand a second
 * signature that no wallet is going to produce.
 */
export function buildContainer(input: BuildContainerInput): Container {
  if (input.ops.length === 0) {
    throw new Error('container: a transaction needs at least one op');
  }
  if (!Number.isInteger(input.nonce) || input.nonce < 0) {
    throw new Error(`container: nonce must be a non-negative integer, got ${input.nonce}`);
  }

  const requiredAuths = [...new Set(input.requiredAuths)];
  if (requiredAuths.length === 0) {
    throw new Error('container: required_auths cannot be empty — nothing would authorise the call');
  }

  // ★ MULTI-AUTH IS REFUSED, AND NOT ARBITRARILY. Two or more auths make
  // `required_auths` an array of >1 element, which the EIP-712 converter turns
  // into a struct type (`tx_container_v0_headers_required_auths`) that nothing
  // references — an ORPHAN. The node produces the identical orphan and verifies
  // it happily, so this is not a mismatch with the chain. It is a mismatch with
  // WALLETS: ethers refuses the payload outright ("ambiguous primary types or
  // unused types"), and a wallet that refuses to display a transaction cannot
  // sign it. Measured 2026-08-20; single-auth payloads are signed identically
  // by viem and ethers and verify against the node.
  //
  // Nothing in this app builds a multi-auth transaction today, so this refuses
  // a shape we never send rather than removing a capability. Deleting the
  // orphan to "fix" it would change the hash and break verification — the fix,
  // when multi-auth is actually needed, is a node-side converter change.
  if (requiredAuths.length > 1) {
    throw new Error(
      `container: ${requiredAuths.length} required_auths — a multi-auth transaction produces an unreferenced ` +
        'EIP-712 type that wallets refuse to display, so it cannot be signed. One auth per transaction.'
    );
  }

  return {
    __t: 'vsc-tx',
    __v: '0.2',
    headers: {
      nonce: input.nonce,
      required_auths: requiredAuths,
      // Equal to the op body's by construction: `buildCallOp` refuses 0 and
      // refuses negatives, so this ternary can no longer produce a header that
      // differs from the body it is signed alongside. Kept as a ternary only so
      // a caller building a container with no ops (there is none today) still
      // gets the node's documented default rather than a 0.
      rc_limit: input.rcLimit > 0 ? input.rcLimit : NODE_DEFAULT_RC_LIMIT,
      net_id: input.netId
    },
    tx: input.ops
  };
}

/**
 * The bytes `submitTransactionV1` takes as `tx`: DAG-CBOR of the container.
 *
 * Note this is the container with BYTE payloads, not the signing shell with
 * string payloads. They are different objects with different CIDs, and sending
 * the wrong one is accepted-then-rejected rather than refused up front.
 */
export function serializeContainer(container: Container): Uint8Array {
  const bytes = encodeDagCbor(container);
  if (bytes.length > MAX_TX_BYTES) {
    // The node refuses at exactly this size (transaction-pool.go:60). Checking
    // here means an oversized transaction costs nothing; discovering it at the
    // node means the user has already approved a wallet prompt for a
    // transaction that was never going to be accepted.
    throw new Error(
      `container: the serialized transaction is ${bytes.length} bytes, over the node's ${MAX_TX_BYTES}-byte limit.`
    );
  }
  return bytes;
}

/** base64 for the GraphQL argument. The node accepts std and url-safe, padded or not. */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return typeof btoa === 'function' ? btoa(binary) : Buffer.from(bytes).toString('base64');
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixed-cost ops: `transfer` and `withdraw` (2026-09-08, wallet Magi tab)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the node decodes for an L2 `transfer` op: `TxVSCTransfer`
 * (state-processing/transactions.go:292-301) — from, to, amount, asset, memo.
 * `net_id` is NOT in the body for this rail: the node fills it from the
 * container headers (transactions.go L2 decode, `NetId: tx.Headers.NetId`), and
 * Altera's own L2 builder omits it (altera-app eth/index.ts:69-79). A body-level
 * net_id would be signed by us and ignored by the node, so it is refused here.
 */
export interface BuildTransferOpInput {
  /** `hive:<name>` or a `did:pkh:…` — must also be the container's required auth. */
  from: string;
  /** `hive:<name>` or a `did:pkh:…`. */
  to: string;
  /** Decimal string with EXACTLY three places, e.g. "1.250" (common.ParseAssetAmount, precision 3). */
  amount: string;
  /** Lower-case ledger asset name. */
  asset: string;
  memo?: string;
}

/** The ledger's transferable set (ledger-system/utils.go:8). */
export const TRANSFERABLE_ASSETS = ['hive', 'hbd', 'hbd_savings'] as const;
/** Withdrawals pay out on Hive L1, which only knows these two. */
export const WITHDRAWABLE_ASSETS = ['hive', 'hbd'] as const;

/** Three-decimal fixed string. The node parses with precision 3 (assets.go:20-21). */
const MAGI_AMOUNT = /^\d{1,15}\.\d{3}$/;

/** The node's own party rule (transactions.go:321-335): a `did:` or `hive:` prefix, nothing else. */
function assertMagiParty(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || !(value.startsWith('hive:') || value.startsWith('did:'))) {
    throw new Error(`container: ${label} must be a hive:<name> or did:… account id`);
  }
}

function assertMagiAmount(amount: unknown): asserts amount is string {
  if (typeof amount !== 'string' || !MAGI_AMOUNT.test(amount)) {
    throw new Error(`container: amount must be a decimal string with exactly three places, got ${String(amount)}`);
  }
  if (Number(amount) <= 0) throw new Error('container: amount must be positive');
}

function fixedCostBody(input: BuildTransferOpInput, assets: readonly string[]): Record<string, unknown> {
  assertMagiParty(input.from, 'from');
  assertMagiParty(input.to, 'to');
  assertMagiAmount(input.amount);
  if (!assets.includes(input.asset)) {
    throw new Error(`container: asset must be one of ${assets.join(', ')}, got ${input.asset}`);
  }
  if ('net_id' in (input as unknown as Record<string, unknown>)) {
    throw new Error('container: net_id belongs in the headers on this rail, not in the op body');
  }
  const body: Record<string, unknown> = {
    from: input.from,
    to: input.to,
    amount: input.amount,
    asset: input.asset
  };
  // Present only when set, as Altera sends it (a signed empty memo is harmless
  // but is not what Altera or the node's own crafter produce).
  if (typeof input.memo === 'string' && input.memo.length > 0) body.memo = input.memo;
  assertSignableShape(body, 'payload');
  return body;
}

/** One L2 `transfer` op. The ledger refuses a self-transfer ("cannot send to self", ledger_session.go:412), so it is refused here too. */
export function buildTransferOp(input: BuildTransferOpInput): ContainerOp {
  if (input.from === input.to) throw new Error('container: transfer to self is refused by the ledger');
  return { type: 'transfer', payload: encodeDagCbor(fixedCostBody(input, TRANSFERABLE_ASSETS)) };
}

/**
 * One L2 `withdraw` op: Magi balance -> Hive L1 account. `to` must name a Hive
 * account (`hive:<name>`): the gateway pays out on L1, where a DID has no
 * meaning. The node only checks non-empty (TxVSCWithdraw.ExecuteTx), so the
 * stricter rule lives here.
 */
export function buildWithdrawOp(input: BuildTransferOpInput): ContainerOp {
  if (!input.to.startsWith('hive:')) {
    throw new Error('container: a withdrawal pays out on Hive, so `to` must be a hive:<name> account');
  }
  return { type: 'withdraw', payload: encodeDagCbor(fixedCostBody(input, WITHDRAWABLE_ASSETS)) };
}

/** The node's fixed RC charges for these ops (transaction-pool/utils.go:67-68). */
export const RC_COST_TRANSFER = 100;
export const RC_COST_WITHDRAW = 200;
