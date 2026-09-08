/**
 * Read raw contract state from the Magi node through the same-origin proxy,
 * with either encoding. The two query constants are the proxy's own allowlisted
 * shapes (app/api/creator-tokens/gql/route.ts imports them by identity), so
 * this cannot drift from what the proxy accepts.
 *
 * Returns a map keyed by the exact key asked for; a missing key is `null`.
 * Throws on any transport or GraphQL failure: a read that failed must never be
 * mistaken for an empty value (magi-balance.ts:26-29).
 */
import { STATE_QUERY, STATE_QUERY_HEX } from '@/blog/features/creator-tokens/lib/vsc/reads';

const CREATOR_TOKENS_GQL_PROXY_PATH = '/api/creator-tokens/gql';

function prop(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

export async function readStateViaProxy(
  contractId: string,
  keys: string[],
  encoding: 'string' | 'hex'
): Promise<Record<string, string | null>> {
  if (!contractId) throw new Error('Magi state read: no contract id');
  if (keys.length === 0 || keys.length > 100) throw new Error('Magi state read: keys must be 1 to 100 items');
  const res = await fetch(CREATOR_TOKENS_GQL_PROXY_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: encoding === 'hex' ? STATE_QUERY_HEX : STATE_QUERY, variables: { contractId, keys } }),
    cache: 'no-store'
  });
  if (res.status === 429) throw new Error('Magi state read: rate limited, try again in a moment');
  if (!res.ok) throw new Error(`Magi state read: HTTP ${res.status}`);
  const json: unknown = await res.json();
  const errors = prop(json, 'errors');
  if (Array.isArray(errors) && errors.length > 0) {
    const first = prop(errors[0], 'message');
    throw new Error(`Magi state read: ${typeof first === 'string' ? first : 'GraphQL error'}`);
  }
  const raw = prop(prop(json, 'data'), 'getStateByKeys');
  const out: Record<string, string | null> = {};
  for (const key of keys) {
    const value = prop(raw, key);
    out[key] = typeof value === 'string' ? value : null;
  }
  return out;
}

/**
 * Decode a Go `big.Int.Bytes()` value the node returned as hex (big-endian
 * magnitude, minimal length; a zero writes zero bytes, so absent or empty is a
 * real 0). Returns null, never 0, for anything that is not hex, so a decode
 * failure cannot read as an empty pool.
 */
export function decodeBigIntBytesHex(hex: string | null | undefined): bigint | null {
  if (hex === null || hex === undefined || hex === '') return BigInt(0);
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]+$/.test(h) || h.length % 2 !== 0) return null;
  return BigInt(`0x${h}`);
}
