/**
 * Turns the Magi indexer's `lumen_pm_pool_history` rows into the per-outcome
 * share series the chart draws.
 *
 * WHY THIS IS ITS OWN MODULE. The conversion has three ways to be quietly wrong
 * — forward-fill, ordering, and money precision — and none of them would look
 * wrong on screen. It is pure so it can be tested directly (`pool-series.selftest.ts`).
 *
 * THE FORWARD-FILL. Each row is a running total for ONE bucket, written only at
 * blocks where that bucket took a bet. A bucket nobody has bet on since block 100
 * still holds its stake at block 500 — it simply has no row there. Reading the
 * rows as-is would make every bucket's line collapse to zero between its own
 * bets. So we walk the rows in block order carrying the latest known total for
 * every bucket, and emit a full column whenever the picture changes.
 *
 * THE MONEY. Totals are base-unit integers arriving as text, and they are summed
 * before being divided. That is done in BigInt: at HBD's 3 decimals a pool only
 * has to reach ~9 billion HBD before a float sum starts dropping units, and
 * "the odds are slightly off" is not a failure anyone would notice in time.
 */

export interface PoolPoint {
  outcome: number;
  block: number;
  /** Running total on that bucket immediately after this bet, base units as text. */
  poolAfter: string;
}

/** Percentage share with two decimals, derived without floats until the last step. */
function sharePct(part: bigint, total: bigint): number {
  if (total <= 0n) return 0;
  return Number((part * 10000n) / total) / 100;
}

function toBigInt(v: string): bigint {
  try {
    return BigInt(v);
  } catch {
    return 0n;
  }
}

/**
 * Returns one share series per outcome (index === outcome), or NULL when there
 * is not enough history to honestly draw anything.
 *
 * NULL below two columns is deliberate and matches the rule the creator-token
 * chart follows: a single point rendered as a line is a claim that the odds held
 * steady across a period we have no data for. Better to show the placeholder and
 * say so than to draw a flat line that looks like evidence.
 */
export function buildOddsSeries(points: PoolPoint[], outcomeCount: number): number[][] | null {
  if (outcomeCount <= 0 || points.length === 0) return null;

  // Block order is the only ordering that means anything here; the indexer
  // returns rows ordered but a caller could merge pages, so sort defensively.
  // Ties (several bets in one block) collapse into that block's single column,
  // which is correct: they are simultaneous as far as the chain is concerned.
  const ordered = [...points].sort((a, b) => a.block - b.block);

  const latest = new Array<bigint>(outcomeCount).fill(0n);
  const columns: number[][] = [];
  let cursor = ordered[0].block;

  const flush = (): void => {
    const total = latest.reduce((sum, v) => sum + v, 0n);
    // A column before any money is on the table carries no information.
    if (total <= 0n) return;
    columns.push(latest.map((v) => sharePct(v, total)));
  };

  for (const point of ordered) {
    if (point.block !== cursor) {
      flush();
      cursor = point.block;
    }
    // Ignore an outcome index the round does not have rather than growing the
    // array — a bucket count mismatch means the caller and the chain disagree,
    // and inventing a lane for it would hide that.
    if (point.outcome >= 0 && point.outcome < outcomeCount) {
      latest[point.outcome] = toBigInt(point.poolAfter);
    }
  }
  flush();

  if (columns.length < 2) return null;

  // Transpose: columns are per-block snapshots, the chart wants per-outcome lines.
  return latest.map((_, outcome) => columns.map((col) => col[outcome]));
}
