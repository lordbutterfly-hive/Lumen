/** USD formatters for the token screens. Everything is USD ($); never HBD/credits. */

/** Token/price with cents: 4.2 → "$4.20", 9.8 → "$9.80". */
export const usdPrice = (n: number): string =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Whole dollars with thousands separators: 84000 → "$84,000", 25 → "$25". */
export const usdWhole = (n: number): string =>
  `$${Math.round(n).toLocaleString('en-US')}`;

/** Compact context figure: 84000 → "$84k", 196000 → "$196k", 1_200_000 → "$1.2M". */
export const usdCompact = (n: number): string => {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}k`;
  return usdWhole(n);
};

/**
 * A percentage LABEL that never claims "none" about something real.
 *
 * ★ WHY THIS IS SHARED AND NOT WRITTEN INLINE. It started inline, in
 * `ui/token-page/token-market-view.tsx`, after 31 tokens out of a 100,000 cap
 * rounded to "0%" and a market with real supply announced itself as untouched.
 * That fix was correct and it did not travel: the identical
 * `Math.round(part / total * 100)` in the creator's own Studio kept saying "0%"
 * about the creator's own token, and two more copies said it about delivery and
 * about the exit fee. Rounding is arithmetically right and the SENTENCE it
 * produces is wrong, so the guard belongs with the formatter, once.
 *
 * Zero means zero. Anything above zero that rounds below half a percent reads
 * "<1%". A total of zero has no percentage to state and returns null, so callers
 * must decide what "not applicable" looks like rather than inheriting a false 0%.
 */
export const pctLabel = (part: number, total: number): string | null => {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return null;
  if (part <= 0) return '0%';
  const pct = Math.min(100, Math.round((part / total) * 100));
  return pct === 0 ? '<1%' : `${pct}%`;
};

/**
 * The numeric twin of `pctLabel`, for bar widths and other geometry — clamped to
 * 0-100, and 0 when there is nothing to divide by. Never render this directly;
 * it is the value that legitimately rounds to 0.
 */
export const pctValue = (part: number, total: number): number => {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((part / total) * 100)));
};

/**
 * A money LABEL that never renders a real balance as "$0".
 *
 * `usdWhole` rounds, so any genuine amount under fifty cents printed as "$0" —
 * which appeared beside an ENABLED "Claim" button on the creator's own trade-fee
 * earnings. Same class as `pctLabel`: the arithmetic was right, the claim was
 * false. Exact zero still prints "$0"; a real amount below the rounding floor
 * prints "<$1".
 */
export const usdWholeNonZero = (n: number): string => {
  if (!Number.isFinite(n) || n <= 0) return usdWhole(0);
  return Math.round(n) === 0 ? '<$1' : usdWhole(n);
};

/**
 * THE MAGNITUDE OF A PRICE MOVE, as a label. Direction is NOT encoded here — the
 * caller carries it (an arrow, a word), so this never has to decide whether a
 * fall should read "-3.1%" or "3.1% down".
 *
 * ★ WHY NOT `pctLabel`. That one answers "what share of a total is this", clamps
 * to 0-100 and cannot express a sign. A price on a bonding curve can double or
 * halve, so a change of +140% or -60% is ordinary and both would be mangled by
 * the clamp. Same house rule though, and for the same reason `pctLabel` has it:
 * a REAL move that rounds below the printed precision must not announce itself
 * as no move at all. 0.04% is not "0%".
 *
 *     not a number      -> null      (the caller renders nothing)
 *     exactly zero      -> '0%'      (a real, measured absence of movement)
 *     0 < |pct| < 0.05  -> '<0.1%'   (moved, below what one decimal can show)
 *     anything else     -> '3.1%'    (one decimal, always)
 */
export const pctMoveLabel = (pct: number): string | null => {
  if (!Number.isFinite(pct)) return null;
  const magnitude = Math.abs(pct);
  if (magnitude === 0) return '0%';
  const rounded = Math.round(magnitude * 10) / 10;
  if (rounded === 0) return '<0.1%';
  return `${rounded.toFixed(1)}%`;
};
