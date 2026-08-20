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
import { ALG_BIP137 } from '@/blog/lib/lite/wallet/vsc-tx/envelope';
import { assertBtcSignature, btcSigningMessage, normalizeBip137Header } from '@/blog/lib/lite/wallet/vsc-tx/btc';
import { type Intent } from '@/blog/lib/lite/wallet/vsc-tx/intents';
import { createSigningShell } from '@/blog/lib/lite/wallet/vsc-tx/signing-shell';
import { submitWithNonce, type SubmitInput, type SubmitResult } from '@/blog/lib/lite/wallet/vsc-tx/submit';

/** Signs EIP-712 typed data. The real one prompts a wallet; tests pass a key. */
export type TypedDataSigner = (address: string, typedData: unknown) => Promise<string>;

/** Signs a plain message with a Bitcoin wallet, returning base64. */
export type BtcMessageSigner = (address: string, message: string) => Promise<string>;

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
): { tx: string; typedData: unknown; shellBytes: Uint8Array } {
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
    typedData: toWalletTypedData(convertCborToEip712TypedData(shellBytes)),
    // The BTC rail signs these bytes' CID instead of the typed data. Returned
    // rather than rebuilt so both rails provably sign the same container.
    shellBytes
  };
}

/** The BTC path never signs typed data; this makes that unmistakable. */
const neverSignsTypedData: TypedDataSigner = () => {
  throw new Error('wallet-broadcaster: the Bitcoin rail does not sign typed data');
};

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

/** CAIP-2 chain id for Bitcoin MAINNET: the first 16 bytes of the genesis hash. */
const BTC_MAINNET_CAIP2 = '000000000019d6689c085ae165831e93';

/**
 * `did:pkh:bip122:<genesis>:<address>` → the Bitcoin address that signs.
 *
 * ★ THE GENESIS IS PINNED TO MAINNET, not matched loosely. The node's
 * `dids.Parse` only ever tries `ParseBtcDID` (mainnet params) and never
 * `ParseBtcTestnetDID`, so a testnet-genesis DID can never verify — but with a
 * loose `[^:]+` it still ROUTED here, prompted the wallet, and was refused at
 * the node afterwards (adversarial review, 2026-08-20). Refusing to route it
 * costs the user nothing; routing it costs them a signing prompt.
 */
export function btcAddressFromDid(did: string): string | null {
  const m = new RegExp(`^did:pkh:bip122:${BTC_MAINNET_CAIP2}:([A-Za-z0-9]+)$`).exec(did);
  return m ? m[1] : null;
}

/** Which of the two address types the node will accept a BIP-322 signature for. */
export function btcAddressType(address: string): 'p2pkh' | 'p2sh' | 'p2wpkh' | null {
  // ★ LENGTH MATTERS, because `bc1q` covers BOTH witness-v0 types. A P2WPKH
  // address encodes a 20-byte program and is 42 characters; a P2WSH encodes a
  // 32-byte program and is 62. The node classifies structurally and refuses
  // P2WSH outright ("unsupported Bitcoin address type:
  // *btcutil.AddressWitnessScriptHash"), so a prefix-only check told the user
  // to sign something that could never verify (adversarial review 2026-08-20).
  // Not reachable from a consumer wallet today; the gate should still match the
  // node's shape rather than its common case.
  if (address.startsWith('bc1q')) return address.length === 42 ? 'p2wpkh' : null;
  if (address.startsWith('3')) return 'p2sh';
  if (address.startsWith('1')) return 'p2pkh';
  // bc1p (taproot) is refused at DID parse by the node (btc.go:52) and blocked
  // at connect time in appkit.ts. Anything else is unknown and must not be
  // guessed at: a wrong type sends a signature the node cannot check.
  return null;
}

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
  if (!did) throw new Error('wallet-broadcaster: the op carries no required auth');
  // The EVM address is absent for a BTC DID; the BTC path supplies its own and
  // never reads this field. Keeping one converter for both rails means the op
  // body is built identically whichever wallet signs it.
  const address = evmAddressFromDid(did) ?? '';

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

/**
 * Broadcast one call signed by a BITCOIN wallet.
 *
 * ★ BITCOIN SIGNS THE CONTAINER'S CID STRING, NOT TYPED DATA. The node hashes
 * `data.Cid().String()` as a plain Bitcoin Signed Message (btc.go:135), so the
 * wallet prompt shows an opaque `bafyrei…`. That is the intended prompt content
 * — the wallet names itself at setup, so the user has a label for what they are
 * approving — and it cannot be made structured without a node change.
 *
 * ★ THE RECOVERY BYTE IS REWRITTEN, AND ONLY HERE. Real SegWit wallets emit
 * BIP-137 headers of 35-38 (P2SH-P2WPKH) or 39-42 (native P2WPKH); Go's
 * `RecoverCompact` accepts only 27-34 and otherwise fails with "failed to
 * recover public key", which reads like a broken wallet. `normalizeBip137Header`
 * fixes that. It must NEVER be applied to the login verifier
 * (`lib/lite/auth/btc-verify.ts`): normalising a header there would accept an
 * ownership proof in a form the wallet did not actually produce.
 */
export async function broadcastBtcWalletCall(
  input: Omit<WalletCallInput, 'signTypedData' | 'address'> & {
    address: string;
    signMessage: BtcMessageSigner;
  }
): Promise<SubmitResult> {
  const addressType = btcAddressType(input.address);
  if (!addressType) {
    throw new Error(
      `wallet-broadcaster: ${input.address} is not an address type the node can verify. ` +
        'Taproot (bc1p) is refused at DID parse; use a native segwit (bc1q), P2SH (3…) or legacy (1…) address.'
    );
  }

  return submitWithNonce(input.did, async (nonce): Promise<SubmitInput> => {
    // ★ ONE BUILDER FOR BOTH RAILS. This used to re-implement `prepareWalletCall`
    // inline. The two were byte-identical, which is precisely why the drift
    // would have been invisible: add a header field to one and the other keeps
    // signing the old shape, and the only symptom is "the signature stopped
    // verifying" (adversarial review, 2026-08-20).
    const { tx, shellBytes } = prepareWalletCall({ ...input, address: '', signTypedData: neverSignsTypedData }, nonce);

    const message = await btcSigningMessage(shellBytes);
    const raw = await input.signMessage(input.address, message);
    const signature = normalizeBip137Header(raw);
    assertBtcSignature(signature, addressType);

    const envelope = buildSigEnvelope([{ alg: ALG_BIP137, sig: signature, kid: input.did }]);
    assertEnvelopeMatchesAuths(envelope, [input.did]);
    return { tx, sig: serializeSigEnvelope(envelope) };
  });
}

/**
 * Collapse a confirmed result into the transaction id the broadcaster contract
 * returns — and refuse to do so for anything we could not confirm.
 *
 * ★ `pending` MUST NOT READ AS SUCCESS. That was the whole defect: a transaction
 * that loses a nonce race is accepted, given a real CID, then dropped at
 * sequencing with no notification, and it sits UNCONFIRMED forever. Returning
 * its id here would put the user back exactly where they started — told it
 * worked, when it may never happen.
 *
 * The message deliberately does NOT say "failed". It says we do not know, and
 * warns against a blind retry, because a retry of something that did land is how
 * a user pays twice.
 */
function requireConfirmed(result: SubmitResult): string {
  if (result.status === 'pending') {
    throw new Error(
      `We couldn't confirm this transaction on chain (${result.id}). It may still land. ` +
        'Check your balance before trying again rather than retrying straight away.'
    );
  }
  return result.id;
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
  signTypedData: TypedDataSigner,
  signBtcMessage: BtcMessageSigner
): OpBroadcaster {
  return async (op: CustomJsonOp): Promise<string> => {
    const auth = op.required_auths[0] ?? '';
    if (!auth.startsWith('did:')) return hiveBroadcaster(op);

    const evm = evmAddressFromDid(auth);
    if (evm) {
      return requireConfirmed(await broadcastWalletCall(opToWalletCall(op, signTypedData)));
    }

    const btc = btcAddressFromDid(auth);
    if (btc) {
      const base = opToWalletCall(op, signTypedData);
      return requireConfirmed(
        await broadcastBtcWalletCall({ ...base, address: btc, signMessage: signBtcMessage })
      );
    }

    throw new Error(`wallet-broadcaster: ${auth} is not a DID this client can sign for.`);
  };
}
