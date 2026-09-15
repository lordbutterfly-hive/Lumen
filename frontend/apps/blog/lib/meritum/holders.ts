/**
 * Pure shaping for the creator page's Holders section and its date cells
 * (handoff §1/§6). No React, no chain — unit-tested directly.
 */

export interface HolderLine {
  /** The account as a URL/handle: `hive:` stripped, a DID left whole. */
  handle: string;
  /** Whether `/@handle` is a page (only a Hive name has one). */
  hasProfile: boolean;
  tokens: number;
  tokensLabel: string;
}

export interface HoldersView {
  rows: HolderLine[];
  /** The REAL count, from the aggregate, not `rows.length`. */
  count: number;
  /** True when `count` exceeds the rows shown, so the header can say so. */
  truncated: boolean;
}

const HIVE_NAME = /^[a-z][a-z0-9.-]{1,15}$/;
/** What the contract accepts as an account (printable ASCII, no `|`, <=160 bytes) — anything else is a corrupt row, not a holder. */
const ACCOUNT_SHAPE = /^[!-{}~]{1,160}$/;

export function tokensLabel(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** Largest first (the indexer already orders, but a caller must not depend on it), zero and malformed rows dropped. */
export function shapeHolders(rows: readonly { holder: string; tokens: number }[], count: number, limit = 8): HoldersView {
  const cleaned = rows
    .filter((r) => typeof r.holder === 'string' && ACCOUNT_SHAPE.test(r.holder) && Number.isFinite(r.tokens) && r.tokens > 0)
    .map((r) => {
      const handle = r.holder.startsWith('hive:') ? r.holder.slice('hive:'.length) : r.holder;
      return { handle, hasProfile: HIVE_NAME.test(handle), tokens: r.tokens, tokensLabel: tokensLabel(r.tokens) };
    })
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, Math.max(0, limit));
  const total = Number.isFinite(count) && count >= 0 ? Math.max(Math.floor(count), cleaned.length) : cleaned.length;
  return { rows: cleaned, count: total, truncated: total > cleaned.length };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "Sep 2026" from an indexer timestamp. The indexer writes `2026-09-09T19:47:00`
 * with no zone, and the value is UTC (it is a block time); parsed as such so a
 * reader west of Greenwich does not see a trade dated the day before it
 * happened. Anything unparseable is null, and a null cell is dropped.
 */
export function monthLabel(ts: string | null | undefined): string | null {
  if (typeof ts !== 'string' || !ts) return null;
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? ts : `${ts}Z`;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  const d = new Date(at);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "14 people hold this Meritum" / "1 person holds this Meritum" — grammar included, so no caller can render "1 people". */
export function holdersHeadline(count: number): string {
  return count === 1 ? '1 person holds this Meritum' : `${count.toLocaleString('en-US')} people hold this Meritum`;
}
