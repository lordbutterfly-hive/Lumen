/**
 * Broadcasting a creator-tokens action from a MULTICHAIN WALLET identity.
 *
 * This is the wallet-native counterpart to `broadcaster.ts`. That file signs a
 * HIVE transaction with a Hive active key (Keychain, PeakVault, the MetaMask
 * Hive Snap — all of which produce a `hive:` account). This one signs a NATIVE
 * Magi transaction with a `did:pkh` identity: an EVM wallet today, a Bitcoin
 * wallet on the same seam later.
 *
 * ★ THE TWO RAILS ARE NOT INTERCHANGEABLE AND MUST NOT BE MERGED. They differ
 * in what is signed (a Hive custom_json vs a DAG-CBOR container), in what
 * authorises it (an active key vs a wallet signature), in where `net_id` lives,
 * and in what pays for it (Hive RC vs the DID's own HBD balance). A single
 * "signer" abstraction over both would have to keep all four straight at every
 * call site, and every one it got wrong would be a silent signature failure.
 *
 * ★ RESOURCE CREDITS ARE THE HIDDEN PRECONDITION. For a `did:pkh` account, RC
 * IS the HBD balance — there is no free tier. `hive:` accounts get 10,000 RC
 * free (params.go RC_HIVE_FREE_AMOUNT), wallet identities get nothing. A wallet
 * user with a zero balance cannot submit ANY transaction, including ones that
 * move no money, and the node's refusal reads "not enough RCS available" with
 * no hint that the fix is to fund the account.
 */

import {
  buildCallOp,
  buildContainer,
  serializeContainer,
  toBase64,
  type ContainerOp
} from '@/blog/lib/lite/wallet/vsc-tx/container';
import { encodeDagCbor, decodeDagCbor } from '@/blog/lib/lite/wallet/vsc-tx/dag-cbor';
import { convertCborToEip712TypedData, toWalletTypedData } from '@/blog/lib/lite/wallet/vsc-tx/eip712';
import {
  ALG_EIP712,
  assertEnvelopeMatchesAuths,
  assertEvmSignature,
  buildSigEnvelope,
  serializeSigEnvelope
} from '@/blog/lib/lite/wallet/vsc-tx/envelope';
import { type Intent } from '@/blog/lib/lite/wallet/vsc-tx/intents';
import { createSigningShell } from '@/blog/lib/lite/wallet/vsc-tx/signing-shell';
import { submitWithNonce, type SubmitInput, type SubmitResult } from '@/blog/lib/lite/wallet/vsc-tx/submit';

/** Signs EIP-712 typed data. The real one prompts a wallet; tests pass a key. */
export type TypedDataSigner = (address: string, typedData: unknown) => Promise<string>;

export interface WalletCallInput {
  /** `did:pkh:eip155:1:0x…` — the caller AND the sole required auth. */
  did: string;
  /** The 0x address inside that DID, which is what the wallet signs with. */
  address: string;
  contractId: string;
  netId: string;
  action: string;
  payload: Record<string, unknown>;
  rcLimit: number;
  intents?: readonly Intent[];
  signTypedData: TypedDataSigner;
}

/**
 * Build the container for one nonce and hand back both the bytes to submit and
 * the typed data to sign. Separated from signing so a retry at a new nonce
 * rebuilds everything rather than reusing a signature that no longer matches.
 */
export function prepareWalletCall(
  input: WalletCallInput,
  nonce: number
): { tx: string; typedData: unknown } {
  const op: ContainerOp = buildCallOp({
    contractId: input.contractId,
    action: input.action,
    payload: input.payload,
    rcLimit: input.rcLimit,
    intents: input.intents,
    caller: input.did
  });

  const container = buildContainer({
    netId: input.netId,
    nonce,
    rcLimit: input.rcLimit,
    requiredAuths: [input.did],
    ops: [op]
  });

  // What the node will rebuild and hash: the container with each op payload
  // re-emitted as a JSON string. See signing-shell.ts and container.ts for why
  // the two layers sort differently.
  const shell = createSigningShell(container as never, (p) => decodeDagCbor(p as Uint8Array));
  const shellBytes = encodeDagCbor(shell as unknown as Record<string, unknown>);

  return {
    tx: toBase64(serializeContainer(container)),
    typedData: toWalletTypedData(convertCborToEip712TypedData(shellBytes))
  };
}

/**
 * The whole flow: read the nonce, build, prompt the wallet, submit — retrying
 * once at a fresh nonce if the first was stale. Returns the transaction CID.
 */
export async function broadcastWalletCall(input: WalletCallInput): Promise<SubmitResult> {
  return submitWithNonce(input.did, async (nonce): Promise<SubmitInput> => {
    const { tx, typedData } = prepareWalletCall(input, nonce);

    const signature = await input.signTypedData(input.address, typedData);
    assertEvmSignature(signature);

    // `kid` is ignored by the node for did:pkh (proven), but a truthful value
    // costs nothing and a lie would break the day it starts being read.
    const envelope = buildSigEnvelope([{ alg: ALG_EIP712, sig: signature, kid: input.did }]);
    assertEnvelopeMatchesAuths(envelope, [input.did]);

    return { tx, sig: serializeSigEnvelope(envelope) };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Routing: one seam, every write action
// ─────────────────────────────────────────────────────────────────────────────

import { type CustomJsonOp } from './op-builders';

/** `did:pkh:eip155:<chain>:<0xaddress>` → the address the wallet signs with. */
export function evmAddressFromDid(did: string): string | null {
  const m = /^did:pkh:eip155:[^:]+:(0x[0-9a-fA-F]{40})$/.exec(did);
  return m ? m[1] : null;
}

/**
 * Turn the op every write method already builds into a wallet-signed call.
 *
 * ★ WHY CONVERT THE OP RATHER THAN ADD A SECOND BUILDER PER ACTION. Every one
 * of the write methods in `vsc-data-source.ts` funnels through `buildOp`, and
 * the JSON it produces already carries everything the container needs:
 * net_id, contract_id, action, payload, rc_limit and intents. Converting here
 * means all 24 write actions reach the wallet rail at once, through the code
 * path that is already covered by `assertPayloadShape` and
 * `assertAuthContract` — instead of 24 opportunities to build a subtly
 * different payload for the second rail.
 *
 * ★ `net_id` MOVES. `buildOp` puts it in the op BODY, which is correct for the
 * Hive custom_json rail and WRONG for this one: `VscContractCall.NetId` is
 * `json:"-"`, so a body-level net_id would be signed by us and dropped by the
 * node, and the signature would not verify. It is lifted into the headers here
 * and deleted from the body.
 */
export function opToWalletCall(op: CustomJsonOp, signTypedData: TypedDataSigner): WalletCallInput {
  const body = JSON.parse(op.json) as {
    net_id: string;
    contract_id: string;
    action: string;
    payload: Record<string, unknown>;
    rc_limit: number;
    intents?: Intent[];
  };

  const did = op.required_auths[0];
  const address = did ? evmAddressFromDid(did) : null;
  if (!did || !address) {
    throw new Error(
      `wallet-broadcaster: required_auths[0] is not an EVM DID (${String(did)}) — only did:pkh:eip155 can sign here today.`
    );
  }

  return {
    did,
    address,
    contractId: body.contract_id,
    netId: body.net_id, // lifted to headers by buildContainer; never in the body
    action: body.action,
    payload: body.payload,
    rcLimit: body.rc_limit,
    intents: body.intents ?? [],
    signTypedData
  };
}

/** A broadcaster in the shape `vsc-data-source.ts` injects. */
export type OpBroadcaster = (op: CustomJsonOp) => Promise<string>;

/**
 * Route each write to the rail its signer actually has.
 *
 * The acting identity is `required_auths[0]`, which the write methods set from
 * the viewer. A `did:pkh:eip155` goes to the wallet rail; everything else is a
 * `hive:` account and goes to the Hive rail unchanged. Nothing else in the data
 * source needs to know which rail it is on, and a Hive user's path is
 * byte-identical to what it was before this existed.
 */
export function routingBroadcaster(
  hiveBroadcaster: OpBroadcaster,
  signTypedData: TypedDataSigner
): OpBroadcaster {
  return async (op: CustomJsonOp): Promise<string> => {
    const auth = op.required_auths[0] ?? '';
    if (!auth.startsWith('did:')) return hiveBroadcaster(op);

    if (!evmAddressFromDid(auth)) {
      // A BTC DID reaches here only if `chainCanSign` was flipped for btc.
      // Refusing loudly beats signing nothing and reporting a wallet error.
      throw new Error(
        'wallet-broadcaster: Bitcoin transaction signing is not enabled — see vsc-tx/btc.ts for why the first one is mainnet-only.'
      );
    }
    const result = await broadcastWalletCall(opToWalletCall(op, signTypedData));
    return result.id;
  };
}
