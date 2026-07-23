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
