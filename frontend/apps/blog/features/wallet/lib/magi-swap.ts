/**
 * Swapping on Magi from the wallet's Magi tab, built on the Magi SDK
 * (@vsc.eco/crosschain-core + -sdk 0.0.3, the owner's own code at
 * /mnt/o/CLONES 2/HOME MAGI/crosschain-sdk, commit 410afba; the npm 0.0.3 dist
 * was checked against that source on 2026-09-08).
 *
 * WHAT IS THE SDK'S: the CLP math (`calculateSwap`, `calculateTwoHopSwap`,
 * core/math/swap.ts), the DEX router `custom_json` op (`getHiveSwapOp`,
 * core/ops/swap.ts:57-152), the base-unit amount type (`CoinAmount`), and the
 * RC arithmetic (`computeSimRcLimit`, `computeBroadcastRcLimit`,
 * `simCallFromSwapOp`, rc.ts).
 *
 * WHAT IS NOT, AND WHY:
 *  - ★ THE QUOTE IS READ FROM CHAIN, NOT FROM THE INDEXER (security review M1,
 *    2026-09-08). The SDK's pool provider takes reserves from the off-chain
 *    indexer, and those reserves become the user's slippage floor
 *    (`min_amount_out`), which the node dry-run cannot validate because a swap
 *    with a too-low floor succeeds. A stale indexer alone, no attacker, would
 *    then ship a floor far below the 1% the reader chose; and on the L1 path a
 *    Hive witness orders the block, while on the L2 path the producer's
 *    shuffle is seeded from the included tx ids (go-vsc-node
 *    modules/block-producer/blockProducer.go:381-388), so an understated floor
 *    is a real, if precondition-gated, loss. So the floor is derived from the
 *    ROUTER'S OWN STATE: the pool id from the router's `pool-{a}-{b}` registry
 *    (dex-router-v2/utils.go:16,44-46), then the pool's `a0n`/`a1n`/`rtr`
 *    strings and `r0`/`r1` reserves as `big.Int.Bytes()`
 *    (dex/contracts/types/constants.go:13-25, dex/utils.go:40-41), all through
 *    the same-origin proxy. A pool whose `rtr` is not our router, or whose
 *    assets are not the pair, is refused. The indexer is not consulted at all.
 *  - The network half of the SDK's RC check dials the node from the browser
 *    (rc.ts:56-68). This app never does; the same two queries go through the
 *    proxy (lib/lite/wallet/magi-simulate.ts).
 *  - `buildQuickSwap` (quickSwap.ts:42-117) is the SDK's MAINNET-TO-MAINNET
 *    product: it prepends an L1 deposit and settles the output back to L1 via
 *    `destination_chain`. On a tab that shows what the reader holds ON Magi,
 *    the coherent swap spends the Magi balance and keeps the output on Magi,
 *    which is `getHiveSwapOp` WITHOUT `destinationChain` (the router then
 *    credits the caller on Magi, the same in-Magi swap Altera offers).
 *  - Signing is the wallet's own active-key path (lib/magi-l1-broadcast.ts),
 *    never Aioha.
 *
 * ★ WALLET-ONLY ACCOUNTS CANNOT SWAP THROUGH THE SDK, proven at source: every
 * SDK swap op is a Hive `custom_json` with `required_auths: [username]`
 * (core/ops/swap.ts:144-147), `buildQuickSwap` takes a Hive `username` and
 * refuses any input asset but HIVE/HBD (quickSwap.ts:17-24,53-55), the RC check
 * keys on `hive:${username}` (rc.ts:270, index.ts:160), and the BTC deposit
 * helper normalises every recipient to `hive:` (mappingBot.ts:21-25). A
 * `did:pkh` identity cannot sign a Hive custom_json at all. Their route is
 * Altera (magi-account-card.tsx renders the link).
 */
import {
  CoinAmount,
  calculateSwap,
  calculateTwoHopSwap,
  getHiveSwapOp,
  type MagiConfig,
  type PoolDepths,
  type SwapAsset,
  type SwapCalcResult
} from '@vsc.eco/crosschain-core';
import { computeBroadcastRcLimit, computeSimRcLimit, simCallFromSwapOp } from '@vsc.eco/crosschain-sdk';
import { toMagiAccountId } from '@/blog/lib/lite/wallet/magi-assets';
import { requiredAuthFor } from './magi-ops';
import { readAccountRcViaProxy, simulateCallViaProxy } from '@/blog/lib/lite/wallet/magi-simulate';
import { decodeBigIntBytesHex, readStateViaProxy } from '@/blog/lib/lite/wallet/magi-state';
import type { MagiSwapConfig } from './magi-swap-config';

export type SwapInputAsset = 'HIVE' | 'HBD';
export const SWAP_INPUT_ASSETS: readonly SwapInputAsset[] = ['HBD', 'HIVE'];
export const SWAP_OUTPUT_ASSETS: readonly SwapAsset[] = ['HBD', 'HIVE', 'BTC'];
export const SLIPPAGE_PRESETS_BPS: readonly number[] = [50, 100, 200, 300];

export function toSdkConfig(c: MagiSwapConfig): MagiConfig {
  return {
    network: c.network,
    dexRouterContractId: c.dexRouterContractId,
    btcMappingContractId: c.btcMappingContractId,
    gatewayAccount: c.gatewayAccount,
    hiveAssetName: c.hiveAssetName,
    hbdAssetName: c.hbdAssetName,
    referral: null
  };
}

/** Router registry keys: `pool-{asset0}-{asset1}` in registration order (dex-router-v2/utils.go:44-46), lowercase names. */
const ROUTER_POOL_PREFIX = 'pool-';
/** Pool state keys (dex/contracts/types/constants.go:13-25). */
const POOL_KEY_ASSET0 = 'a0n';
const POOL_KEY_ASSET1 = 'a1n';
const POOL_KEY_ROUTER = 'rtr';
const POOL_KEY_RESERVE0 = 'r0';
const POOL_KEY_RESERVE1 = 'r1';

/**
 * The pool the router would route `a`/`b` through, read from chain and
 * validated: the pool must name our router as its authorised router and must
 * carry exactly this pair. Returns null when the router has no pool for the
 * pair; THROWS on a transport failure or a pool that fails validation, so a
 * failed read can never become a quote.
 */
export async function readPoolFromChain(routerId: string, a: string, b: string): Promise<PoolDepths | null> {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  const keys = [`${ROUTER_POOL_PREFIX}${la}-${lb}`, `${ROUTER_POOL_PREFIX}${lb}-${la}`];
  const registry = await readStateViaProxy(routerId, keys, 'string');
  const poolId = registry[keys[0]] || registry[keys[1]] || null;
  if (!poolId) return null;

  const [meta, reserves] = await Promise.all([
    readStateViaProxy(poolId, [POOL_KEY_ASSET0, POOL_KEY_ASSET1, POOL_KEY_ROUTER], 'string'),
    readStateViaProxy(poolId, [POOL_KEY_RESERVE0, POOL_KEY_RESERVE1], 'hex')
  ]);
  const asset0 = (meta[POOL_KEY_ASSET0] ?? '').toLowerCase();
  const asset1 = (meta[POOL_KEY_ASSET1] ?? '').toLowerCase();
  const router = meta[POOL_KEY_ROUTER] ?? '';
  if (router !== routerId) {
    throw new Error(`Magi swap: pool ${poolId} is not authorised by router ${routerId}`);
  }
  if (!((asset0 === la && asset1 === lb) || (asset0 === lb && asset1 === la))) {
    throw new Error(`Magi swap: pool ${poolId} carries ${asset0}/${asset1}, not ${la}/${lb}`);
  }
  const reserve0 = decodeBigIntBytesHex(reserves[POOL_KEY_RESERVE0]);
  const reserve1 = decodeBigIntBytesHex(reserves[POOL_KEY_RESERVE1]);
  if (reserve0 === null || reserve1 === null) {
    throw new Error(`Magi swap: pool ${poolId} reserves could not be decoded`);
  }
  return { contractId: poolId, asset0, asset1, reserve0, reserve1 };
}

export interface SwapQuote {
  amountIn: CoinAmount;
  assetIn: SwapInputAsset;
  assetOut: SwapAsset;
  slippageBps: number;
  preview: SwapCalcResult & { hops: 1 | 2 };
  /** The pools the quote was computed from, read from chain at quote time. */
  pools: PoolDepths[];
}

function orderedDepths(depths: PoolDepths, assetIn: string): { X: bigint; Y: bigint } | null {
  const a = assetIn.toLowerCase();
  if (depths.asset0 === a) return { X: depths.reserve0, Y: depths.reserve1 };
  if (depths.asset1 === a) return { X: depths.reserve1, Y: depths.reserve0 };
  return null;
}

/**
 * Direct pool first, else two hops through HBD (mirrors quickSwap.ts:128-186 and
 * the router's own autodiscovery), with every reserve read from chain. Returns
 * null when no route exists so the dialog says "no pool" instead of quoting
 * zero; throws on a failed read so the dialog says "couldn't reach" instead.
 */
export async function quoteSwap(
  routerId: string,
  input: { assetIn: SwapInputAsset; assetOut: SwapAsset; amountIn: string; slippageBps: number }
): Promise<SwapQuote | null> {
  const { assetIn, assetOut, slippageBps } = input;
  if ((assetIn as string) === assetOut) throw new Error('assetIn and assetOut must differ');
  const amountIn = CoinAmount.fromDecimal(input.amountIn, assetIn);
  if (amountIn.raw <= BigInt(0)) throw new Error('amount must be positive');

  const direct = await readPoolFromChain(routerId, assetIn, assetOut);
  if (direct) {
    const d = orderedDepths(direct, assetIn);
    if (d && d.X > BigInt(0) && d.Y > BigInt(0)) {
      const r = calculateSwap(amountIn.raw, d.X, d.Y, slippageBps);
      return { amountIn, assetIn, assetOut, slippageBps, preview: { ...r, hops: 1 }, pools: [direct] };
    }
    // A registered pool with an empty side cannot fill anything.
    return null;
  }
  const mid: SwapAsset = 'HBD';
  if (assetIn === mid || assetOut === mid) return null;
  const [pool1, pool2] = await Promise.all([readPoolFromChain(routerId, assetIn, mid), readPoolFromChain(routerId, mid, assetOut)]);
  if (!pool1 || !pool2) return null;
  if (pool1.reserve0 <= BigInt(0) || pool1.reserve1 <= BigInt(0) || pool2.reserve0 <= BigInt(0) || pool2.reserve1 <= BigInt(0)) return null;
  const r = calculateTwoHopSwap(amountIn.raw, pool1, pool2, assetIn.toLowerCase(), mid.toLowerCase(), assetOut.toLowerCase(), slippageBps);
  return { amountIn, assetIn, assetOut, slippageBps, preview: { ...r, hops: 2 }, pools: [pool1, pool2] };
}

/**
 * The in-Magi swap op: caller's Magi balance in, output stays on Magi under the
 * caller. ★ REFUSES a floor of zero (security review L1): the SDK writes an
 * absent `minAmountOut` as the literal `"0"`, i.e. "accept any output", so a
 * quote whose floor rounded down to nothing must never reach an op.
 */
export function buildMagiSwapOp(username: string, quote: SwapQuote, config: MagiConfig, rcLimit?: number): unknown {
  if (quote.preview.expectedOutput <= BigInt(0) || quote.preview.minAmountOut <= BigInt(0)) {
    throw new Error('Magi swap: the quoted floor is zero; refusing to build an op that would accept any output');
  }
  return getHiveSwapOp({
    username,
    amountIn: quote.amountIn,
    assetIn: quote.assetIn,
    assetOut: quote.assetOut,
    minAmountOut: quote.preview.minAmountOut,
    config,
    rcLimit
  });
}

export interface SwapRcCheck {
  simOk: boolean;
  rcUsed: bigint;
  rcAvailable: bigint;
  sufficient: boolean;
  rcShortfall: bigint;
  simRcLimit: number;
  broadcastRcLimit: number;
  err?: string;
  errMsg?: string;
}

/** The SDK's `checkSwapRc` (rc.ts:262-283), with its two node calls routed through the proxy. */
export async function checkSwapRcViaProxy(callerId: string, swapOp: unknown): Promise<SwapRcCheck> {
  // `hive:<name>` or a did:pkh — the simulate call is keyed by the ledger id either way.
  const caller = toMagiAccountId(callerId);
  const call = simCallFromSwapOp(swapOp);
  const rcAvailable = await readAccountRcViaProxy(caller);
  const simRcLimit = computeSimRcLimit(rcAvailable, call);
  const sim = await simulateCallViaProxy(caller, call, simRcLimit);
  const shortfall = sim.rcUsed > rcAvailable ? sim.rcUsed - rcAvailable : BigInt(0);
  return {
    simOk: sim.success,
    rcUsed: sim.rcUsed,
    rcAvailable,
    sufficient: sim.success && shortfall === BigInt(0),
    rcShortfall: shortfall,
    simRcLimit,
    broadcastRcLimit: computeBroadcastRcLimit(simRcLimit, sim.rcUsed),
    err: sim.err,
    errMsg: sim.errMsg
  };
}

/** Unwrap the `custom_json` tuple the SDK builds into the fields wax's `custom_json_operation` wants. */
/**
 * The SDK's swap op for ANY Magi account, not only a Hive one (2026-09-08).
 *
 * `getHiveSwapOp` hard-codes `caller = hive:${username}` and
 * `required_auths: [username]` (crosschain-core dist/index.js:197,235). The
 * router itself has no such rule: `Execute` accepts any sender whose address is
 * among its own required auths (dex-router-v2/main.go:224-235) and validates the
 * recipient only as a Magi address (main.go:264-267), which a did:pkh is. So a
 * wallet login swaps with the identical instruction, caller and recipient set to
 * its DID — the same op Altera's EVM/BTC paths would sign. This mirrors the SDK
 * builder line for line (payload, action `execute`, rc_limit default 2000, the
 * transfer.allow intent for a native input) and, for a Hive caller, is asserted
 * byte-identical to the SDK's output in magi-ops.selftest.ts. Referral fees are
 * off in Lumen's config (toSdkConfig: referral null), so that branch is omitted.
 */
export function buildMagiSwapCustomJson(
  callerId: string,
  quote: SwapQuote,
  config: MagiConfig,
  rcLimit?: number
): { id: string; json: string; required_auths: string[]; required_posting_auths: string[] } {
  if (quote.preview.expectedOutput <= BigInt(0) || quote.preview.minAmountOut <= BigInt(0)) {
    throw new Error('Magi swap: the quoted floor is zero; refusing to build an op that would accept any output');
  }
  const caller = toMagiAccountId(callerId);
  const isNative = quote.assetIn === 'HIVE' || quote.assetIn === 'HBD';
  const payload = {
    type: 'swap',
    version: '1.0.0',
    asset_in: quote.assetIn,
    asset_out: quote.assetOut,
    amount_in: quote.amountIn.raw.toString(),
    min_amount_out: quote.preview.minAmountOut.toString(),
    recipient: caller
  };
  const op = {
    net_id: config.network,
    caller,
    contract_id: config.dexRouterContractId,
    action: 'execute',
    payload: JSON.stringify(payload),
    rc_limit: rcLimit ?? 2000,
    intents: isNative
      ? [{ type: 'transfer.allow', args: { limit: quote.amountIn.toDecimalString(), token: quote.assetIn.toLowerCase() } }]
      : []
  };
  return { required_auths: [requiredAuthFor(caller)], required_posting_auths: [], id: 'vsc.call', json: JSON.stringify(op) };
}

export function customJsonFromSdkOp(op: unknown): { id: string; json: string; required_auths: string[]; required_posting_auths: string[] } {
  if (!Array.isArray(op) || op[0] !== 'custom_json') throw new Error('expected a custom_json op');
  const body = op[1] as { id?: unknown; json?: unknown; required_auths?: unknown; required_posting_auths?: unknown };
  if (typeof body?.id !== 'string' || typeof body?.json !== 'string' || !Array.isArray(body.required_auths) || !Array.isArray(body.required_posting_auths)) {
    throw new Error('malformed custom_json op');
  }
  return { id: body.id, json: body.json, required_auths: body.required_auths as string[], required_posting_auths: body.required_posting_auths as string[] };
}

/** Base units to a fixed decimal string for display; integer arithmetic only. */
export function formatSwapAmount(raw: bigint, asset: SwapAsset): string {
  return new CoinAmount(raw, asset).toDecimalString();
}
