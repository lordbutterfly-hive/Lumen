/**
 * ★ THE BUY IS DONE WHEN THE DRAW IS ON THE LEDGER, NOT WHEN IT IS ANCHORED
 * (owner, 2026-09-15, after a live funded buy: "its still spinning after 3
 * minutes... i still think its too long", "have it close when its safe").
 *
 * What happened on that buy (Hive tx ff43500a…, 19:42:09): the node executed
 * the deposit AND the buy in the very next block, 19:42:12, and wrote the
 * draw to its ledger (`<txid>#in` −2.142 HBD from the buyer, `<txid>#out`
 * +2.142 to the contract). The transaction's STATUS only turned CONFIRMED
 * once the contract output was anchored on Hive, more than three minutes
 * later, past the dialog's 180 s wait. The status is the finality signal;
 * the ledger draw is the execution signal, and it is what the whole app
 * already reads state from (supply, holdings, balances all came from this
 * node's state within seconds).
 *
 * So a buy resolves on EITHER: the terminal status, or the buyer's draw for
 * that transaction on the ledger. A failed call writes no draw (the ledger
 * session is reverted before it is committed), so a draw is never a false
 * positive. Finality is still watched in the background and a later FAILED
 * is surfaced, but nobody waits three minutes for a checkpoint.
 *
 * Pure: `findLedgerTXs(byTxId)` rows in, a verdict out. Tested in
 * lib/__tests__/meritum-executed-signal.test.ts.
 */
export interface LedgerRow {
  id: string;
  owner: string;
  amount: number;
  asset: string;
  type: string;
}

function toDid(account: string): string {
  return account.startsWith('hive:') || account.startsWith('did:') ? account : `hive:${account}`;
}

/** The buyer's HBD draw for `txId` is on the ledger: the buy executed. */
export function buyExecutedIn(rows: readonly LedgerRow[] | null | undefined, txId: string, buyer: string): boolean {
  if (!Array.isArray(rows) || !txId) return false;
  const owner = toDid(buyer);
  return rows.some(
    (r) =>
      r &&
      typeof r.id === 'string' &&
      r.id === `${txId}#in` &&
      r.owner === owner &&
      r.asset === 'hbd' &&
      r.type === 'transfer' &&
      typeof r.amount === 'number' &&
      r.amount < 0
  );
}

/** The deposit that rode in front of the buy was credited to the buyer (the funded rail). */
export function depositCreditedIn(rows: readonly LedgerRow[] | null | undefined, txId: string, buyer: string): boolean {
  if (!Array.isArray(rows) || !txId) return false;
  const owner = toDid(buyer);
  return rows.some((r) => r && r.id === txId && r.owner === owner && r.type === 'deposit' && typeof r.amount === 'number' && r.amount > 0);
}

/** Parse what the proxy returns, refusing anything that is not a row list. */
export function parseLedgerRows(json: unknown): LedgerRow[] | null {
  if (typeof json !== 'object' || json === null) return null;
  const data = (json as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return null;
  const rows = (data as { findLedgerTXs?: unknown }).findLedgerTXs;
  if (!Array.isArray(rows)) return null;
  const out: LedgerRow[] = [];
  for (const r of rows) {
    if (typeof r !== 'object' || r === null) continue;
    const { id, owner, amount, asset, type } = r as Record<string, unknown>;
    if (typeof id !== 'string' || typeof owner !== 'string' || typeof asset !== 'string' || typeof type !== 'string') continue;
    const n = typeof amount === 'number' ? amount : typeof amount === 'string' ? Number(amount) : Number.NaN;
    if (!Number.isFinite(n)) continue;
    out.push({ id, owner, amount: n, asset, type });
  }
  return out;
}
