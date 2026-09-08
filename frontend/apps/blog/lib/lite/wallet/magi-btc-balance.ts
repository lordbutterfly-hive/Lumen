/**
 * Bitcoin held on Magi.
 *
 * BTC is NOT a field of the node's balance record. It lives in the BTC mapping
 * contract's own state, keyed `a-<account id>`, exactly as Altera reads it
 * (altera-app/src/lib/stores/currentBalance.ts:56-75). Verified at the contract
 * source: the key is `BalancePrefix + vscAcc` with `BalancePrefix = "a" + "-"`
 * (btc-mapping-contract/contract/constants/constants.go:3,73) and the value is a
 * COMPACT BIG-ENDIAN uint64 with leading zero bytes trimmed; a zero balance
 * DELETES the key (contract/mapping/utils.go:758-778). The unit is sats
 * (8 decimals).
 *
 * ★ BIG-endian, the OPPOSITE byte order of the creator-token matured family
 * that `reads.ts`'s `decodeMaturedLeHex` decodes. Never reuse that decoder here.
 *
 * ★ MUST be read with `encoding: "hex"` (`STATE_QUERY_HEX`): the node's default
 * string cast corrupts raw bytes (reads.ts:240-247).
 *
 * Which contract: `REACT_APP_MAGI_BTC_MAPPING_CONTRACT_ID`. Altera and the Magi
 * SDK agree on the ids (altera-app/src/lib/constants.ts:9-11,
 * crosschain-sdk/packages/core/src/types/index.ts:38,57) but the value is
 * configuration here, like every other contract id in this app.
 */
import env from '@beam-australia/react-env';
import { STATE_QUERY_HEX } from '@/blog/features/creator-tokens/lib/vsc/reads';
import { toMagiAccountId } from './magi-assets';

export const BTC_BALANCE_KEY_PREFIX = 'a-';

export function btcBalanceKey(rawAccount: string): string {
  return `${BTC_BALANCE_KEY_PREFIX}${toMagiAccountId(rawAccount)}`;
}

export function getMagiBtcMappingContractId(): string | null {
  const value = env('MAGI_BTC_MAPPING_CONTRACT_ID');
  return value && value.length > 0 ? value : null;
}

/**
 * Decode the contract's wire form. Returns null (never 0) when the bytes cannot
 * be a balance; an absent or empty value IS a real zero because the contract
 * deletes the key at zero.
 */
export function decodeBigEndianTrimmedHex(hex: string | null | undefined): bigint | null {
  if (hex === null || hex === undefined || hex === '') return BigInt(0);
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return null;
  if (hex.length > 16) return null; // more than 8 bytes cannot be a uint64
  return BigInt(`0x${hex}`);
}

/** Sats to a fixed 8-decimal string, integer arithmetic only. */
export function formatSats(sats: bigint): string {
  const whole = sats / BigInt(100_000_000);
  const frac = sats % BigInt(100_000_000);
  return `${whole.toString()}.${frac.toString().padStart(8, '0')}`;
}

const CREATOR_TOKENS_GQL_PROXY_PATH = '/api/creator-tokens/gql';

function prop(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

/**
 * Read the mapped BTC balance (sats) for one account. Throws on transport or
 * GraphQL failure and on undecodable bytes; resolves 0 for a missing key.
 */
export async function readMagiBtcBalance(contractId: string, rawAccount: string): Promise<bigint> {
  if (!contractId) throw new Error('Magi BTC read: no mapping contract configured');
  if (!rawAccount) throw new Error('Magi BTC read: no account given');
  const key = btcBalanceKey(rawAccount);
  const res = await fetch(CREATOR_TOKENS_GQL_PROXY_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: STATE_QUERY_HEX, variables: { contractId, keys: [key] } }),
    cache: 'no-store'
  });
  if (res.status === 429) throw new Error('Magi BTC read: rate limited, try again in a moment');
  if (!res.ok) throw new Error(`Magi BTC read: HTTP ${res.status}`);
  const json: unknown = await res.json();
  const errors = prop(json, 'errors');
  if (Array.isArray(errors) && errors.length > 0) {
    const first = prop(errors[0], 'message');
    throw new Error(`Magi BTC read: ${typeof first === 'string' ? first : 'GraphQL error'}`);
  }
  const value = prop(prop(prop(json, 'data'), 'getStateByKeys'), key);
  const sats = decodeBigEndianTrimmedHex(typeof value === 'string' ? value : null);
  if (sats === null) throw new Error(`Magi BTC read: malformed balance bytes for ${key}`);
  return sats;
}
