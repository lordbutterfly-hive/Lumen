// Money conversion between the frontend's human `number` (round.asset units, as
// used throughout types.ts / bucket pools / bet amounts) and the two on-chain
// string encodings the VSC market contract uses.
//
// GROUND TRUTH (read from the contract, not guessed):
//   - Native HIVE/HBD carry 3 decimal places. market/params.go MinBet="1000"
//     with the comment "3-decimal HIVE/HBD ⇒ 1000 = 1.000", and sdk.HiveDraw
//     takes an int64 count of base units.
//   - State money (pool, op|k, st|acct|k, stt|acct, drem, wrem) is a *big.Int
//     serialized as a base-10 INTEGER string of base units (market/util.go
//     getMoney/setMoney → v.String()). So "5000" means 5.000 HIVE, NOT "5".
//   - The `bet` payload `amount` field is parsed by contract/main.go
//     parseBigDecimal → big.Int.SetString(s,10): a base-unit INTEGER string
//     (e.g. "5000"). A "5.000" here would be REJECTED as "invalid amount".
//   - The `transfer.allow` intent `limit` is a human DECIMAL string ("5.000")
//     converted by go-vsc-node common.ParseDecimalsToBaseUnits.
// The two encodings in a single bet op are therefore different string forms of
// the same value; humanToBaseUnits() feeds the payload, humanToDecimalString()
// feeds the intent.

export const ASSET_DECIMALS = 3;
const SCALE = 10 ** ASSET_DECIMALS;

function assertNonNegativeFinite(amount: number): void {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(`vsc-money: amount must be a non-negative finite number, got ${amount}`);
  }
}

/**
 * Human units → base-unit INTEGER string for the contract `bet` payload amount.
 * Uses toFixed(3) (not float multiply) so 0.1 → "100", never "100.00000001".
 * e.g. 5 → "5000", 0.25 → "250", 10 → "10000".
 */
export function humanToBaseUnits(amount: number): string {
  assertNonNegativeFinite(amount);
  const fixed = amount.toFixed(ASSET_DECIMALS); // "5.000"
  const [intPart, fracPart = ''] = fixed.split('.');
  const digits = `${intPart}${fracPart}`.replace(/^0+(?=\d)/, '');
  return digits === '' ? '0' : digits;
}

/**
 * Human units → human DECIMAL string for the `transfer.allow` intent `limit`.
 * e.g. 5 → "5.000". Paired with a `decimals: "3"` intent arg so the runtime's
 * ParseDecimalsToBaseUnits resolves it unambiguously to base units.
 */
export function humanToDecimalString(amount: number): string {
  assertNonNegativeFinite(amount);
  return amount.toFixed(ASSET_DECIMALS);
}

/**
 * Base-unit INTEGER string (from state) → human units for display.
 * Missing/empty/invalid → 0 (mirrors the contract's getMoney treating "" as 0).
 * NOTE: JS `number` loses precision above 2^53 base units (~9e12 HIVE); not a
 * concern for this market's realistic pool sizes, but the frontend money type
 * is `number` so there is nothing to do about it here.
 */
export function baseUnitsToHuman(value: string | null | undefined): number {
  if (!value) return 0;
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return n / SCALE;
}
