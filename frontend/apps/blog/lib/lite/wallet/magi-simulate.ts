/**
 * Dry-run a Magi contract call and read an account's resource credits, both
 * through the same-origin proxy.
 *
 * The Magi SDK's own `checkSwapRc` (crosschain-sdk/packages/sdk/src/rc.ts:56-68)
 * dials the node directly from the browser. This app deliberately never does
 * (app/api/creator-tokens/gql/route.ts, and the CSP that enforces it), so the
 * network half is re-done here against the proxy while the arithmetic stays the
 * SDK's own exported helpers (`computeSimRcLimit`, `computeBroadcastRcLimit`,
 * `simCallFromSwapOp`). The query text below is byte-for-byte the SDK's
 * (rc.ts:220), which is also the shape rc-budget.ts:160-200 documents.
 */
import { BALANCE_QUERY } from './magi-balance';

export const SIMULATE_QUERY =
  'query($input: SimulateContractCallsInput!) { simulateContractCalls(input: $input) { success err err_msg rc_used } }';

export interface SimulateCall {
  contract_id: string;
  action: string;
  payload: string;
  rc_limit: number;
  intents: Array<{ type: string; args: Record<string, string> }>;
}

export interface SimulateOutcome {
  success: boolean;
  rcUsed: bigint;
  err?: string;
  errMsg?: string;
}

const CREATOR_TOKENS_GQL_PROXY_PATH = '/api/creator-tokens/gql';

function prop(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

async function postProxy(query: string, variables: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(CREATOR_TOKENS_GQL_PROXY_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    cache: 'no-store'
  });
  if (res.status === 429) throw new Error('Magi: rate limited, try again in a moment');
  if (!res.ok) throw new Error(`Magi: HTTP ${res.status}`);
  const json: unknown = await res.json();
  const errors = prop(json, 'errors');
  if (Array.isArray(errors) && errors.length > 0) {
    const first = prop(errors[0], 'message');
    throw new Error(`Magi: ${typeof first === 'string' ? first : 'GraphQL error'}`);
  }
  return prop(json, 'data');
}

/** Available RC for a Magi account id (`hive:<name>` or `did:pkh:…`). Throws when the node has no record. */
export async function readAccountRcViaProxy(account: string): Promise<bigint> {
  const data = await postProxy(BALANCE_QUERY, { account });
  const rc = prop(data, 'getAccountRC');
  const amount = prop(rc, 'amount');
  if (rc === null || rc === undefined || (typeof amount !== 'number' && typeof amount !== 'string')) {
    throw new Error(`Magi: no resource-credit record for ${account}`);
  }
  return BigInt(amount);
}

/** Simulate one call as `caller` with the given rc_limit. Never signs, never submits. */
export async function simulateCallViaProxy(caller: string, call: SimulateCall, rcLimit: number): Promise<SimulateOutcome> {
  const txId = `sim-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const data = await postProxy(SIMULATE_QUERY, {
    input: {
      tx_id: txId,
      required_auths: [caller],
      required_posting_auths: [],
      calls: [{ ...call, rc_limit: rcLimit }]
    }
  });
  const list = prop(data, 'simulateContractCalls');
  const first = Array.isArray(list) ? list[0] : undefined;
  if (!first) throw new Error('Magi: simulateContractCalls returned no results');
  const rcUsed = prop(first, 'rc_used');
  return {
    success: prop(first, 'success') === true,
    rcUsed: BigInt(typeof rcUsed === 'number' || typeof rcUsed === 'string' ? rcUsed : 0),
    err: typeof prop(first, 'err') === 'string' ? (prop(first, 'err') as string) : undefined,
    errMsg: typeof prop(first, 'err_msg') === 'string' ? (prop(first, 'err_msg') as string) : undefined
  };
}
