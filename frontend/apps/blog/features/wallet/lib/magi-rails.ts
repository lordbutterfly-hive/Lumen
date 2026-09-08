'use client';

/**
 * One seam for "this account signs a Magi transaction", whichever way it logged in.
 *
 * ★ THREE LOGINS, THREE SIGNERS, ONE NODE. The owner's model — "if you login to
 * Lumen you should be logged into Magi and Hive at the same time; BTC and EVM
 * login are all equal to Keychain" — is exactly how Altera works and how the
 * node reads:
 *
 *   Hive (Keychain / PeakVault / active key)
 *     signs a Hive custom_json with the ACTIVE key; the node prefixes each auth
 *     with `hive:` and executes it as an L1-originated Magi tx
 *     (Altera: aioha executeTx; Lumen: lib/magi-l1-broadcast.ts, the same path
 *     the deposit already takes).
 *   EVM wallet (did:pkh:eip155)
 *     signs the DAG-CBOR container as EIP-712 typed data with the connected
 *     wallet (Altera: eth/client.ts:249-331 + wagmiSigner; Lumen:
 *     wallet-broadcaster.ts broadcastWalletOps + appkit signTypedDataWith).
 *   Bitcoin wallet (did:pkh:bip122)
 *     signs the container CID as a Bitcoin Signed Message, BIP-137
 *     (Altera: bitcoin/signer.ts:14; Lumen: broadcastBtcWalletOps + appkit
 *     signMessageWith('btc')).
 *
 * The wallet signers come from `lite-auth/wallet/appkit` — the same Reown
 * AppKit session the wallet login created. A returning session holds the DID in
 * the cookie, not the wallet; `getModal()` reconnects the wallet when the sign
 * request needs it, so "logged into Lumen" is enough to start a Magi transaction
 * (the wallet still confirms each one, as Keychain does).
 *
 * ★ TERMINAL, NOT ACCEPTED. Every rail returns only after the node reports the
 * transaction CONFIRMED or FAILED (submit.ts waitForTerminal) or the wait runs
 * out, and says which. INCLUDED is not a balance.
 */
import { signMessageWith, signTypedDataWith } from '@/blog/features/lite-auth/wallet/appkit';
import type { TokenAccount } from '@/blog/features/creator-tokens/live/use-token-accounts';
import type { CustomJsonOp } from '@/blog/features/creator-tokens/lib/vsc/op-builders';
import {
  broadcastBtcWalletCall,
  broadcastBtcWalletOps,
  broadcastWalletCall,
  broadcastWalletOps,
  btcAddressFromDid,
  evmAddressFromDid,
  opToWalletCall,
  requireConfirmed
} from '@/blog/features/creator-tokens/lib/vsc/wallet-broadcaster';
import {
  buildTransferOp,
  buildWithdrawOp,
  RC_COST_TRANSFER,
  RC_COST_WITHDRAW,
  type ContainerOp
} from '@/blog/lib/lite/wallet/vsc-tx/container';
import { waitForTerminal, type TerminalStatus } from '@/blog/lib/lite/wallet/vsc-tx/submit';
import { broadcastMagiL1 } from './magi-l1-broadcast';
import { magiTransferCustomJson, magiWithdrawCustomJson, type MagiMoveInput } from './magi-ops';

export type MagiRailPhase = 'signing' | 'submitted' | 'confirming';

export interface MagiRailOptions {
  onPhase?: (phase: MagiRailPhase) => void;
  /** How long to wait for CONFIRMED/FAILED after acceptance. */
  terminalTimeoutMs?: number;
}

export interface MagiRailResult {
  /** Hive trx id (Hive login) or the container CID (wallet login). */
  id: string;
  status: TerminalStatus;
}

/**
 * Measured (creator-tokens vsc-data-source.ts, 2026-09-01): Hive-rail broadcast
 * to CONFIRMED ~72s on testnet; the wallet rail ~3.5x faster. 180s covers both
 * with margin; past it the caller is told "unconfirmed", never "done".
 */
const TERMINAL_TIMEOUT_MS = 180_000;

const btcSigner = (address: string, message: string) => signMessageWith('btc', address, message);

function walletKind(account: TokenAccount): 'hive' | 'evm' | 'btc' {
  if (account.kind === 'hive') return 'hive';
  if (evmAddressFromDid(account.id)) return 'evm';
  if (btcAddressFromDid(account.id)) return 'btc';
  throw new Error(`magi-rails: ${account.id} is not an account this client can sign for`);
}

async function finish(id: string, opts: MagiRailOptions): Promise<MagiRailResult> {
  opts.onPhase?.('confirming');
  const status = await waitForTerminal(id, opts.terminalTimeoutMs ?? TERMINAL_TIMEOUT_MS);
  if (status === 'failed') {
    throw new Error(`Magi rejected this transaction at execution (${id}). Nothing moved.`);
  }
  return { id, status };
}

/**
 * A `vsc.call`-shaped op (BTC transfer / unmap, swap) on whichever rail the
 * account uses — the creator-tokens routing (wallet-broadcaster.ts
 * routingBroadcaster) applied to the wallet's own ops.
 */
export async function broadcastMagiCall(
  account: TokenAccount,
  op: CustomJsonOp,
  opts: MagiRailOptions = {}
): Promise<MagiRailResult> {
  const kind = walletKind(account);
  opts.onPhase?.('signing');
  if (kind === 'hive') {
    const { transactionId } = await broadcastMagiL1(account.id, (tx) => {
      tx.pushOperation({ custom_json_operation: op });
    });
    opts.onPhase?.('submitted');
    return finish(transactionId, opts);
  }
  if (kind === 'evm') {
    const id = requireConfirmed(await broadcastWalletCall(opToWalletCall(op, signTypedDataWith)));
    opts.onPhase?.('submitted');
    return finish(id, opts);
  }
  const base = opToWalletCall(op, signTypedDataWith);
  const address = btcAddressFromDid(account.id);
  if (!address) throw new Error('magi-rails: no Bitcoin address in the DID');
  const id = requireConfirmed(await broadcastBtcWalletCall({ ...base, address, signMessage: btcSigner }));
  opts.onPhase?.('submitted');
  return finish(id, opts);
}

async function broadcastFixedCost(
  account: TokenAccount,
  input: MagiMoveInput,
  shape: 'transfer' | 'withdraw',
  opts: MagiRailOptions
): Promise<MagiRailResult> {
  const kind = walletKind(account);
  opts.onPhase?.('signing');
  if (kind === 'hive') {
    const op = shape === 'transfer' ? magiTransferCustomJson(input) : magiWithdrawCustomJson(input);
    const { transactionId } = await broadcastMagiL1(account.id, (tx) => {
      tx.pushOperation({ custom_json_operation: op });
    });
    opts.onPhase?.('submitted');
    return finish(transactionId, opts);
  }
  // The wallet rail: the op body has no net_id (headers carry it), same as Altera's L2 builder.
  const body = { from: input.from, to: input.to, amount: input.amount, asset: input.asset, memo: input.memo };
  const op: ContainerOp = shape === 'transfer' ? buildTransferOp(body) : buildWithdrawOp(body);
  const rcLimit = shape === 'transfer' ? RC_COST_TRANSFER : RC_COST_WITHDRAW;
  if (kind === 'evm') {
    const address = evmAddressFromDid(account.id);
    if (!address) throw new Error('magi-rails: no EVM address in the DID');
    const id = requireConfirmed(
      await broadcastWalletOps({ did: account.id, address, netId: input.netId, rcLimit, ops: [op], signTypedData: signTypedDataWith })
    );
    opts.onPhase?.('submitted');
    return finish(id, opts);
  }
  const address = btcAddressFromDid(account.id);
  if (!address) throw new Error('magi-rails: no Bitcoin address in the DID');
  const id = requireConfirmed(
    await broadcastBtcWalletOps({ did: account.id, address, netId: input.netId, rcLimit, ops: [op], signMessage: btcSigner })
  );
  opts.onPhase?.('submitted');
  return finish(id, opts);
}

/** HBD / HIVE from this Magi account to another Magi account. */
export function broadcastMagiTransfer(account: TokenAccount, input: MagiMoveInput, opts: MagiRailOptions = {}) {
  return broadcastFixedCost(account, input, 'transfer', opts);
}

/** HBD / HIVE from this Magi account to a Hive L1 account. */
export function broadcastMagiWithdraw(account: TokenAccount, input: MagiMoveInput, opts: MagiRailOptions = {}) {
  return broadcastFixedCost(account, input, 'withdraw', opts);
}
