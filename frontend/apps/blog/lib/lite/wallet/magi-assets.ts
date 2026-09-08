/**
 * Everything one account holds on Magi (the Hive layer 2 Meritum runs on), in one read.
 *
 * `lib/lite/wallet/magi-balance.ts` reads HBD + resource credits because that is
 * all a purchase needs. The wallet's Magi tab shows the whole ledger record the
 * node keeps for an account, the same seven fields Altera's balance card reads
 * (altera-app/src/lib/AccBalance.gql), so this is a WIDER query beside the
 * narrow one, not a replacement: every existing caller of `BALANCE_QUERY` is
 * untouched.
 *
 * Units: every amount is an integer in base units with THREE decimals
 * (`1000` = 1.000 HBD or 1.000 HIVE; schema.graphql BalanceRecord "in smallest
 * unit"). Never put one through a float; format at the edge.
 *
 * ★ A FAILED READ IS NOT A ZERO BALANCE (same rule as magi-balance.ts:26-29).
 * Transport or GraphQL failures throw. The two "the node answered" cases that
 * mean a genuine zero are handled exactly as magi-balance.ts:170-232 already
 * decided them: a missing balance row beside an RC row is zero, and both rows
 * missing is "no Magi account yet", also zero.
 */

export const MAGI_ASSETS_QUERY = `query MagiAccountAssets($account: String!) {
  getAccountBalance(account: $account) { account block_height hbd hbd_savings pending_hbd_unstaking hive hive_consensus consensus_unstaking }
  getAccountRC(account: $account) { account amount max_rcs }
}`;

export interface MagiAssets {
  /** The Magi account id the ledger keys by: `hive:<name>` or a `did:pkh:…`. */
  account: string;
  /** Block height the balance row was recorded at; 0 when there is no row. */
  blockHeight: number;
  /** Liquid HBD, base units (3 decimals). */
  hbdBaseUnits: number;
  /** HBD in Magi savings (sHBD), base units. */
  hbdSavingsBaseUnits: number;
  /** HBD currently unstaking from savings, base units. */
  hbdUnstakingBaseUnits: number;
  /** Liquid HIVE on Magi, base units. */
  hiveBaseUnits: number;
  /** HIVE staked for consensus, base units. */
  hiveConsensusBaseUnits: number;
  /** HIVE currently unstaking from consensus, base units. */
  hiveUnstakingBaseUnits: number;
  rc: { amount: number; maxRcs: number };
}

/**
 * The ledger keys accounts by an EXACT string, and a bare Hive name is simply
 * a different (never-existing) account. `TokenAccount.id` carries a bare name
 * for a Hive identity and a full `did:pkh:…` for a wallet, so every reader
 * normalises here (magi-balance.ts:131-149 documents the silent-zero this
 * prevents).
 */
export function toMagiAccountId(raw: string): string {
  return raw.startsWith('hive:') || raw.startsWith('did:') ? raw : `hive:${raw}`;
}

/** Same-origin proxy every Magi read goes through; the node is never dialled from the browser. */
const CREATOR_TOKENS_GQL_PROXY_PATH = '/api/creator-tokens/gql';

function prop(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

function asInt(value: unknown, field: string): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) throw new Error(`Magi assets read: ${field} was not a number (got ${JSON.stringify(value)})`);
  return n;
}

/** `pending_hbd_unstaking` is the one nullable field in BalanceRecord; absent means nothing is unstaking. */
function asIntOrZero(value: unknown, field: string): number {
  return value === null || value === undefined ? 0 : asInt(value, field);
}

function zeroAssets(account: string): MagiAssets {
  return {
    account,
    blockHeight: 0,
    hbdBaseUnits: 0,
    hbdSavingsBaseUnits: 0,
    hbdUnstakingBaseUnits: 0,
    hiveBaseUnits: 0,
    hiveConsensusBaseUnits: 0,
    hiveUnstakingBaseUnits: 0,
    rc: { amount: 0, maxRcs: 0 }
  };
}

/** Parse the node's `{data}` envelope. Exported so the selftest can drive it without a network. */
export function parseMagiAssets(json: unknown, account: string): MagiAssets {
  const errors = prop(json, 'errors');
  if (Array.isArray(errors) && errors.length > 0) {
    const first = prop(errors[0], 'message');
    throw new Error(`Magi assets read: ${typeof first === 'string' ? first : 'GraphQL error'}`);
  }
  const data = prop(json, 'data');
  const bal = prop(data, 'getAccountBalance');
  const rcNode = prop(data, 'getAccountRC');
  const balMissing = bal === null || bal === undefined;
  const rcMissing = rcNode === null || rcNode === undefined;
  // Both missing: the node answered and holds nothing for this account. A real zero
  // (magi-balance.ts:197-232), never an unknown.
  if (balMissing && rcMissing) return zeroAssets(account);
  if (rcMissing) throw new Error(`Magi assets read: the node has no resource-credit record for ${account}`);
  const rc = { amount: asInt(prop(rcNode, 'amount'), 'amount'), maxRcs: asInt(prop(rcNode, 'max_rcs'), 'max_rcs') };
  if (balMissing) return { ...zeroAssets(account), rc };
  return {
    account,
    blockHeight: asInt(prop(bal, 'block_height'), 'block_height'),
    hbdBaseUnits: asInt(prop(bal, 'hbd'), 'hbd'),
    hbdSavingsBaseUnits: asInt(prop(bal, 'hbd_savings'), 'hbd_savings'),
    hbdUnstakingBaseUnits: asIntOrZero(prop(bal, 'pending_hbd_unstaking'), 'pending_hbd_unstaking'),
    hiveBaseUnits: asInt(prop(bal, 'hive'), 'hive'),
    hiveConsensusBaseUnits: asInt(prop(bal, 'hive_consensus'), 'hive_consensus'),
    hiveUnstakingBaseUnits: asInt(prop(bal, 'consensus_unstaking'), 'consensus_unstaking'),
    rc
  };
}

/**
 * Read one account's Magi balances through the same-origin proxy. Throws on any
 * transport or GraphQL failure so no caller can mistake "could not ask" for
 * "holds nothing".
 */
export async function readMagiAssets(rawAccount: string): Promise<MagiAssets> {
  if (!rawAccount) throw new Error('Magi assets read: no account given');
  const account = toMagiAccountId(rawAccount);
  const res = await fetch(CREATOR_TOKENS_GQL_PROXY_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: MAGI_ASSETS_QUERY, variables: { account } }),
    cache: 'no-store'
  });
  if (res.status === 429) throw new Error('Magi assets read: rate limited, try again in a moment');
  if (!res.ok) throw new Error(`Magi assets read: HTTP ${res.status}`);
  return parseMagiAssets(await res.json(), account);
}
