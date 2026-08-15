/**
 * THE MONEY-INPUT RULES BOTH LAUNCH FLOWS OBEY.
 *
 * Extracted from `studio/launch-wizard.tsx` on 2026-08-15, when the Meritum
 * launch flow (`meritum/launch/`) became the second screen that asks a creator
 * to type a price. Worth a shared module rather than a second copy for one
 * reason: the three-decimal rule below is not obvious, and a fork of it lets
 * one screen accept a price the chain will reject while the other refuses it.
 *
 * ★ NOTHING CHANGED IN THE MOVE. The wizard imports the same four values it
 * used to define locally, with the same comments, so its behaviour is
 * byte-identical to before the extraction.
 */

import { MAX_FACE_BASE_UNITS, MIN_FACE_BASE_UNITS } from '../lib/contract-math';

/**
 * ★ ONE SUPPLY FOR EVERY TOKEN (owner ruling, 2026-08-08).
 *
 * The wizard used to make a creator choose between Tight / Balanced / Generous
 * (5,000 / 20,000 / 100,000) on a step of its own. That is a genuinely hard
 * question — it sets how fast the price climbs — asked of someone who has not yet
 * sold anything, and it bought nothing: the cap can be RAISED at any time from the
 * Studio, so a low start is strictly the safer default. The step is gone and every
 * token launches at the smallest of the three.
 */
export const STANDARD_CAP = 5000;

/**
 * ★ A PRICE FIELD THAT ACCEPTS "banana".
 *
 * The service-price and first-buy inputs stored whatever was typed — `abc`,
 * `-50`, `999999999999` all survived into later steps and kept Continue
 * enabled. The Supply step one screen along already strips non-digits from its
 * own field, so the wizard disagreed with itself about whether its money inputs
 * are validated. Found by an exploratory UX tester 2026-08-06.
 *
 * Permissive on purpose: it never rejects a keystroke mid-typing (`1.` and ``
 * are both fine while the reader is still going), it only refuses what cannot
 * be a dollar amount — letters, symbols, a minus sign, a second decimal point,
 * and more than two decimal places.
 */
export function sanitizeMoneyInput(raw: string): string {
  const cleaned = (raw ?? '').replace(/[^\d.]/g, '');
  const [whole, ...rest] = cleaned.split('.');
  // ★ THREE decimals, not two (2026-08-07). HBD carries 3dp and the contract's
  // own minimum posted price is 577 base units = $0.577 — at 2dp a creator
  // could not type the legal minimum at all; `0.577` silently became `0.57`,
  // which is BELOW the floor and would be rejected on chain after signing.
  return rest.length ? `${whole}.${rest.join('').slice(0, 3)}` : whole;
}

/**
 * ★ RANGE VALIDATION (2026-08-07, found in live QA against the deployed
 * contract). Bounds come from contract-math.ts's mirrors of core/params.go,
 * never from literals here, so they cannot drift from the contract. Without
 * them a price outside the band is rejected on chain AFTER the creator has
 * approved a signature — the worst possible moment to find out.
 */
export const MIN_PRICE_USD = MIN_FACE_BASE_UNITS / 1000;
export const MAX_PRICE_USD = MAX_FACE_BASE_UNITS / 1000;

/**
 * A sanitised field as a number. `''`, `'.'` and anything non-finite are 0,
 * which every caller reads as "not offered" rather than as free.
 *
 * NEW in the extraction, used by the Meritum flow only — the wizard keeps its
 * own inline parse so that its blank-versus-invalid distinction is untouched.
 */
export function parseMoney(raw: string): number {
  const n = parseFloat((raw ?? '').replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : 0;
}
