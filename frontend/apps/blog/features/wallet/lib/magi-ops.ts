/**
 * Magi send / withdraw operations, ported from Altera.
 *
 * THE SHAPES ARE ALTERA'S, VERBATIM. One Magi account sends to another with
 * either a Hive L1 custom_json (a Keychain / PeakVault / active-key login) or a
 * native Magi container (an EVM or Bitcoin wallet login). Both reach the same
 * node code:
 *
 *   Hive login   custom_json id `vsc.transfer`  altera-app/src/lib/magiTransactions/hive/vscOperations/transfer.ts:20-46
 *                custom_json id `vsc.withdraw`  …/withdrawal.ts:21-47
 *                custom_json id `vsc.call`      …/bitcoin.ts:22-52 (BTC on Magi = the mapping contract's `transfer`)
 *                                               …/bitcoin.ts:59-90 (`unmap` = withdraw BTC to a Bitcoin address)
 *   Wallet login container op `transfer` / `withdraw` / `call`
 *                                               altera-app/src/lib/magiTransactions/eth/index.ts:13-96,
 *                                               signed EIP-712 (wagmiSigner) or BIP-137 (bitcoin/signer.ts:14),
 *                                               dispatched at sendUtils.ts:611-632
 *
 * Node side, both rails decode to the same structs: TxVSCTransfer / TxVSCWithdraw /
 * TxVscCallContract (go-vsc-node state-processing/transactions.go:292-301, L1 at
 * state_engine.go's custom_json switch with `hive:` prefixed auths, L2 at
 * transactions.go's container switch with net_id from the headers).
 *
 * Recipient parsing is Altera's `getDidFromUsername`
 * (altera-app/src/lib/getAccountName.ts:48-62): a Hive name, an 0x address, a
 * Bitcoin address, or an already-qualified `hive:` / `did:pkh:` id. Two places
 * are STRICTER than Altera on purpose (owner, 2026-09-09: "it needs to be safe"):
 * an Ethereum address is EIP-55 checksummed (viem `isAddress`, strict: a
 * mixed-case address with the wrong case is refused; all-lowercase is accepted
 * as the standard allows) where Altera accepts any 42-char 0x string
 * (sendUtils.ts validateAddress), and a Bitcoin address must pass
 * bitcoin-address-validation's checksum AND be a type the node can verify
 * (taproot refused, btc.go:52).
 *
 * ★ THE SAME GATE ON EVERY FORM (security scrutiny S-1, 2026-09-09). The first
 * cut applied those checks to bare addresses only; a `did:pkh:` string went
 * through on regex shape alone, so a one-character typo of a real Bitcoin
 * address was refused bare and ACCEPTED in DID form, while the card printed
 * "checksum valid". A qualified id is now unwrapped, run through exactly the
 * bare-form checks, pinned to the namespaces Magi uses (eip155:1, Bitcoin
 * mainnet), and re-emitted in canonical form.
 */
import Big from 'big.js';
import { isAddress } from 'viem';
import { validate as validateBtcAddress, Network as BtcNetwork } from 'bitcoin-address-validation';
import type { CustomJsonOp } from '@/blog/features/creator-tokens/lib/vsc/op-builders';
import { btcAddressType, evmAddressFromDid, btcAddressFromDid } from '@/blog/features/creator-tokens/lib/vsc/wallet-broadcaster';

/** CAIP-2 for Bitcoin mainnet — the only Bitcoin DID the node parses (dids.Parse never tries testnet). */
export const BTC_MAINNET_CAIP2 = '000000000019d6689c085ae165831e93';

export type MagiSendAsset = 'HBD' | 'HIVE' | 'BTC';

export interface MagiRecipient {
  /** The ledger id: `hive:<name>` or `did:pkh:…`. */
  id: string;
  kind: 'hive' | 'evm' | 'btc';
  /** For a Hive recipient, the bare name (to check it exists before sending). */
  hiveName?: string;
  /**
   * True ONLY when a checksum was actually verified on this input: a mixed-case
   * EIP-55 address, or a Bitcoin address (bech32 / base58check always carry one).
   * An all-lowercase Ethereum address has no checksum to verify; the UI must not
   * claim one (security scrutiny S-1, 2026-09-09).
   */
  checksummed?: boolean;
}

const HIVE_NAME = /^[a-z][a-z0-9.-]{2,15}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Altera's `getDidFromUsername`, with the one difference that an unrecognised
 * input returns null instead of a guessed DID: a wrong guess on a money form
 * strands funds under an id nobody controls.
 */
export function parseMagiRecipient(raw: string): MagiRecipient | null {
  const value = raw.trim();
  if (value.length === 0) return null;
  if (value.startsWith('hive:')) {
    const name = value.slice('hive:'.length).toLowerCase();
    return HIVE_NAME.test(name) ? { id: `hive:${name}`, kind: 'hive', hiveName: name } : null;
  }
  if (value.startsWith('did:pkh:')) {
    const evm = evmAddressFromDid(value);
    if (evm) {
      // Magi's only EVM namespace is eip155:1 (dids.ParseEthDID); a Polygon or
      // garbage chain id is not a Magi account, whatever the address.
      if (!/^did:pkh:eip155:1:0x/.test(value)) return null;
      if (!isAddress(evm)) return null;
      return { id: `did:pkh:eip155:1:${evm.toLowerCase()}`, kind: 'evm', checksummed: evm !== evm.toLowerCase() };
    }
    const btc = btcAddressFromDid(value);
    if (btc && isPayableBtcAddress(btc)) return { id: `did:pkh:bip122:${BTC_MAINNET_CAIP2}:${btc}`, kind: 'btc', checksummed: true };
    return null;
  }
  const bare = value.startsWith('@') ? value.slice(1) : value;
  if (bare.length <= 16) {
    const name = bare.toLowerCase();
    return HIVE_NAME.test(name) ? { id: `hive:${name}`, kind: 'hive', hiveName: name } : null;
  }
  if (EVM_ADDRESS.test(bare)) {
    // EIP-55: a mixed-case address must carry the right checksum; all-lowercase is valid by the standard.
    if (!isAddress(bare)) return null;
    // Altera lower-cases the address (getAccountName.ts:57); the node compares DIDs as strings.
    // An all-lowercase address passes EIP-55 by definition and carries NO checksum to verify.
    return { id: `did:pkh:eip155:1:${bare.toLowerCase()}`, kind: 'evm', checksummed: bare !== bare.toLowerCase() };
  }
  const addr = bare.includes(':') ? (bare.split(':').at(-1) ?? bare) : bare;
  if (isPayableBtcAddress(addr)) {
    return { id: `did:pkh:bip122:${BTC_MAINNET_CAIP2}:${addr}`, kind: 'btc', checksummed: true };
  }
  return null;
}

/** Why a typed recipient did not parse, for the picker's copy: the shape it looked like, if any. */
export function recipientShapeHint(raw: string): 'evm' | 'btc' | 'hive' | 'unknown' {
  const bare = raw.trim().replace(/^@/, '');
  if (/^0x/i.test(bare)) return 'evm';
  if (/^(bc1|[13])[a-zA-HJ-NP-Z0-9]{10,}$/.test(bare) || bare.startsWith('did:pkh:bip122')) return 'btc';
  if (bare.length > 0 && bare.length <= 16) return 'hive';
  return 'unknown';
}

/** A Bitcoin address the bridge can pay: checksummed and of a type the node verifies. */
export function isPayableBtcAddress(addr: string): boolean {
  return btcAddressType(addr) !== null && validateBtcAddress(addr, BtcNetwork.mainnet);
}

/** Altera's display rule (getAccountName.ts:20-27): bc1… keeps 8 + 5, 0x… keeps 6 + 4. */
export function shortenRecipient(id: string): string {
  const u = bareHiveName(id).split(':').at(-1) ?? id;
  if (u.length <= 16) return u;
  if (u.startsWith('bc1')) return `${u.slice(0, 8)}…${u.slice(-5)}`;
  return `${u.slice(0, 6)}…${u.slice(-4)}`;
}

/** `hive:alice` -> `alice`; a DID is returned unchanged. */
export function bareHiveName(id: string): string {
  return id.startsWith('hive:') ? id.slice('hive:'.length) : id;
}

/** `required_auths` for a custom_json: bare Hive name on L1 (the node re-prefixes `hive:`), the DID itself on L2. */
export function requiredAuthFor(callerId: string): string {
  return callerId.startsWith('hive:') ? bareHiveName(callerId) : callerId;
}

/** Three-decimal fixed string, the node's transfer precision (assets.go:20-21). Integer-safe via Big. */
export function formatMagiAmount(amount: Big | string | number): string {
  return new Big(amount).toFixed(3);
}

/** Satoshis as an integer string — the mapping contract's `amount` (Altera bitcoin.ts:31, eth/index.ts:23). */
export function btcToSats(amountBtc: Big | string | number): string {
  const sats = new Big(amountBtc).times(100_000_000);
  if (!sats.eq(sats.round(0, 0))) throw new Error('Bitcoin amounts carry at most eight decimals');
  return sats.toFixed(0);
}

export interface MagiMoveInput {
  /** `hive:<name>` or `did:pkh:…` — the account that pays. */
  from: string;
  /** `hive:<name>` or `did:pkh:…`. */
  to: string;
  /** Three-decimal string. */
  amount: string;
  /** `hive` | `hbd` (lower case, the ledger's names). */
  asset: 'hive' | 'hbd';
  memo?: string;
  netId: string;
}

/**
 * Hive-login SEND on Magi: custom_json `vsc.transfer` (Altera transfer.ts:26-45).
 * `from` is `hive:`-prefixed in the json AND the bare name is the required auth;
 * the node prefixes auths itself (state_engine.go custom_json branch) and then
 * checks `from` is among them (transactions.go:329).
 */
export function magiTransferCustomJson(input: MagiMoveInput): CustomJsonOp {
  const json: Record<string, string> = {
    from: input.from,
    to: input.to,
    asset: input.asset,
    net_id: input.netId,
    amount: input.amount
  };
  if (input.memo) json.memo = input.memo;
  return {
    required_auths: [requiredAuthFor(input.from)],
    required_posting_auths: [],
    id: 'vsc.transfer',
    json: JSON.stringify(json)
  };
}

/** Hive-login WITHDRAW to Hive L1: custom_json `vsc.withdraw` (Altera withdrawal.ts:27-46). */
export function magiWithdrawCustomJson(input: MagiMoveInput): CustomJsonOp {
  if (!input.to.startsWith('hive:')) throw new Error('a withdrawal pays out on Hive; `to` must be hive:<name>');
  const json: Record<string, string> = {
    from: input.from,
    to: input.to,
    asset: input.asset,
    net_id: input.netId,
    amount: input.amount
  };
  if (input.memo) json.memo = input.memo;
  return {
    required_auths: [requiredAuthFor(input.from)],
    required_posting_auths: [],
    id: 'vsc.withdraw',
    json: JSON.stringify(json)
  };
}

/** Altera's rc_limit for a mapping-contract transfer (bitcoin.ts:41, eth/index.ts:33). */
export const BTC_TRANSFER_RC_LIMIT = 1000;
/** Altera's rc_limit for an unmap (bitcoin.ts:81, eth/index.ts:53). */
export const BTC_UNMAP_RC_LIMIT = 10_000;

export interface MagiBtcMoveInput {
  caller: string;
  /** `to`: a Magi account id for transfer; a raw Bitcoin address for unmap. */
  to: string;
  /** Satoshis, integer string. */
  sats: string;
  contractId: string;
  netId: string;
}

/**
 * BTC on Magi moves through the mapping contract: `vsc.call` action `transfer`
 * with `{amount, to}` (Altera bitcoin.ts:22-52). The same CustomJsonOp serves
 * both rails: on L1 it is the custom_json; on L2 `opToWalletCall` lifts net_id
 * into the headers and makes it the container's `call` op, with the DID as the
 * required auth and caller — exactly Altera's eth/index.ts:20-39.
 */
export function magiBtcTransferCustomJson(input: MagiBtcMoveInput): CustomJsonOp {
  if (!/^\d+$/.test(input.sats) || BigInt(input.sats) <= BigInt(0)) throw new Error('sats must be a positive integer string');
  const json = {
    net_id: input.netId,
    caller: input.caller,
    contract_id: input.contractId,
    action: 'transfer',
    payload: { amount: input.sats, to: input.to },
    rc_limit: BTC_TRANSFER_RC_LIMIT,
    intents: [] as never[]
  };
  return {
    required_auths: [requiredAuthFor(input.caller)],
    required_posting_auths: [],
    id: 'vsc.call',
    json: JSON.stringify(json)
  };
}

/** Withdraw BTC to a Bitcoin address: mapping-contract `unmap` (Altera bitcoin.ts:59-90, eth/index.ts:40-59). */
export function magiBtcUnmapCustomJson(input: MagiBtcMoveInput): CustomJsonOp {
  if (!/^\d+$/.test(input.sats) || BigInt(input.sats) <= BigInt(0)) throw new Error('sats must be a positive integer string');
  if (!btcAddressType(input.to)) throw new Error('unmap needs a Bitcoin address the bridge can pay (bc1q…, 3…, 1…)');
  const json = {
    net_id: input.netId,
    caller: input.caller,
    contract_id: input.contractId,
    action: 'unmap',
    payload: { amount: input.sats, to: input.to },
    rc_limit: BTC_UNMAP_RC_LIMIT,
    intents: [] as never[]
  };
  return {
    required_auths: [requiredAuthFor(input.caller)],
    required_posting_auths: [],
    id: 'vsc.call',
    json: JSON.stringify(json)
  };
}
