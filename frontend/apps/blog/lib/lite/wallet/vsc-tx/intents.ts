/**
 * Intents — the spend authority that rides alongside a contract call.
 *
 * An intent is how a caller says "this contract may draw at most N HBD from me
 * during this transaction". For creator tokens it is the buyer's ONLY slippage
 * protection: `buy` draws `cost + fee` in one `HiveDraw` AFTER the core has
 * already mutated state (core/buy.go:38-40), so the allowance is what bounds
 * the draw, not any in-core cap.
 *
 * ★ THIS IS NET-NEW CAPABILITY. Neither Altera rail supports intents — both
 * type `intents` as an empty tuple and never populate it. The node needs no
 * change to accept them (they ride inside the op body, which is CBOR-encoded
 * and handed to the contract host verbatim), but nothing on the wallet rail has
 * ever sent one. That has a hard consequence for sequencing: `register` draws
 * no HBD (main.go:683-686) so it needs no intent and is reachable first, while
 * `buy` cannot work at all until intents are correct.
 *
 * ★ EVERY ARG VALUE IS A STRING, BY TYPE. The node declares
 * `Intent.Args map[string]string` (db/vsc/contracts/schema.go:38-41). A number
 * here does not fail loudly — it fails at CBOR decode on the node side, after
 * the user has signed and paid. `limit` is therefore formatted as a decimal
 * string with exactly three places, matching the HBD precision the ledger uses.
 */

/** One spend authority, shaped exactly as the node's `contracts.Intent`. */
export interface Intent {
  type: string;
  args: Record<string, string>;
}

/** HBD carries three decimal places on Hive and on the Magi ledger alike. */
const HBD_DECIMALS = 3;

/**
 * The base-unit → decimal-string conversion, done with integer arithmetic.
 *
 * `(baseUnits / 1000).toFixed(3)` is what the existing Hive rail does
 * (op-builders.ts:144) and it is correct for every value this app can produce,
 * but it routes an exact integer through a binary float on the way to a string
 * that must be exact. Doing it with integer division and a pad keeps the value
 * exact for any input, including ones above 2^53 that a future caller might
 * hand us — the same class of loss `assertSignableShape` refuses elsewhere.
 */
export function hbdBaseUnitsToDecimalString(baseUnits: number): string {
  if (!Number.isInteger(baseUnits)) {
    throw new Error(`intents: an HBD amount must be a whole number of base units, got ${baseUnits}`);
  }
  if (baseUnits < 0) {
    throw new Error(`intents: an HBD amount cannot be negative, got ${baseUnits}`);
  }
  // ★ BigInt, not Number arithmetic. This function's own comment used to claim
  // it stayed exact "for any input, including ones above 2^53" — and it did
  // not: `Math.floor(n / 1000)` and `n % 1000` are Number operations, so
  // 1152921504606847000 formatted as "1152921504606847.976" against an exact
  // "1152921504606846.976" (adversarial review, 2026-08-20; 10 mismatches in
  // 300k probes). The error OVERSTATED the allowance, which is the wrong
  // direction for a spend cap. Unreachable with real money — 2^53 milli-HBD is
  // 9e12 HBD — but a comment that promises exactness has to be true, and the
  // cheapest way to make it true is to stop lying with Numbers.
  const scale = BigInt(10 ** HBD_DECIMALS);
  const units = BigInt(baseUnits);
  const whole = units / scale;
  const frac = units % scale;
  return `${whole}.${String(frac).padStart(HBD_DECIMALS, '0')}`;
}

/**
 * The HBD spend allowance for a call. `limitBaseUnits` is the ceiling in
 * milli-HBD, i.e. the same unit `TotalDue` uses throughout contract-math.ts.
 *
 * Shape is byte-identical to what the Hive rail already sends
 * (op-builders.ts:144) — deliberately, so both transports produce the same
 * intent for the same buy and a divergence would be a visible diff rather than
 * a silent behavioural split.
 */
export function transferAllowIntent(limitBaseUnits: number): Intent {
  return {
    type: 'transfer.allow',
    args: {
      limit: hbdBaseUnitsToDecimalString(limitBaseUnits),
      token: 'hbd',
      decimals: String(HBD_DECIMALS)
    }
  };
}

/**
 * Refuse an intent list that cannot mean what the caller thinks it means.
 *
 * Called unconditionally at container build time rather than in dev only. An
 * intent that the node decodes differently than we intended is not a display
 * bug — it is a spend authority, and the failure mode is authorising more than
 * the user agreed to.
 */
export function assertIntentsShape(intents: readonly Intent[]): void {
  for (const [i, intent] of intents.entries()) {
    if (typeof intent?.type !== 'string' || intent.type.length === 0) {
      throw new Error(`intents[${i}]: type must be a non-empty string`);
    }
    if (intent.args === null || typeof intent.args !== 'object' || Array.isArray(intent.args)) {
      throw new Error(`intents[${i}]: args must be an object`);
    }
    for (const [k, v] of Object.entries(intent.args)) {
      if (typeof v !== 'string') {
        throw new Error(
          `intents[${i}].args.${k}: every intent arg must be a STRING — the node types Args as ` +
            `map[string]string, so a ${typeof v} fails at decode on the node, after the user has signed.`
        );
      }
    }
  }
}
