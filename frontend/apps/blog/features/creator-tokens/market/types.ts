/**
 * Bonding-curve MARKET view-model for the redesign token screens.
 *
 * Deliberately separate from the audited access-credit data layer
 * (`features/creator-tokens/{types,hooks,lib}.ts`): these are the USD-denominated
 * market shapes the UI renders (price / market cap / floor / supply / chart /
 * buy-sell quotes). The numbers come from the contract's real curve math
 * (`price(i) = BasePrice + a·i + b·i²`, reserve = area(S)) — see `curve.ts` —
 * fed by mock data now, swapped to live indexer reads on deploy.
 *
 * Model rules (handoff, non-negotiable): everything is USD ($) + tokens, NEVER
 * HBD/credits; price + market cap + FLOOR always together; delivery record as
 * prominent as price; never volume/order-book/leaderboard.
 */

export interface DeliveryRecord {
  answered: number;
  total: number;
  /**
   * 0–100, completion rate — or **null when the creator has no deliveries yet**.
   *
   * ★ NULL IS NOT ZERO, AND CONFLATING THEM DEFAMED EVERY NEW CREATOR
   * (found on the live testnet market 2026-08-17). This was a plain `number`,
   * and `adaptDelivery` computed `total === 0 ? 0 : ...`, so a creator who had
   * never sold a service rendered on their own token page as:
   *
   *     0% completion rate — completed 0 of 0 · usually within .
   *
   * A buyer reads "0% completion rate" as "this person does not deliver". It is
   * the strongest negative claim on the page, it was asserted about people who
   * had simply never been asked for anything, and it is the state EVERY market
   * is in on the day it launches.
   *
   * `available` cannot express this: false already means "the indexer could not
   * be reached", and rendering "record unavailable" for a creator whose record
   * we read perfectly well is the same class of lie in the other direction. The
   * three states are distinct and must stay distinct:
   *
   *     available:false                  -> "Delivery record unavailable"  (read failed)
   *     available:true,  completionPct:null -> "No deliveries yet"         (read fine, nothing to report)
   *     available:true,  completionPct:0    -> "0% completion rate"        (asked, and did not deliver)
   *
   * Nullable rather than a companion boolean so the compiler forces every
   * consumer to answer the question — the same shape `CreatorSummary.completionPct`
   * already uses for exactly this distinction, which the creators grid ranks on
   * (`ui/creators/creators-view.tsx`'s `proven`).
   */
  completionPct: number | null;
  /** Human "usually within ~6h". Empty string when there is nothing to summarise — callers MUST NOT render it unguarded, or the sentence ends "usually within .". */
  typicalResponse: string;
  /** ~12 recent marks, newest last. true = answered, false = missed. */
  marks: boolean[];
  /** false → render "Delivery record unavailable" (NOT rank-boosted — missing ≠ perfect). */
  available: boolean;
}

/** Compact creator+token summary for the Creators grid and Your-Tokens rows. */
export interface CreatorTokenSummary {
  /** Hive handle without the leading @. */
  handle: string;
  /** One-line "what they do" (rendered in Lora). */
  what: string;
  /** Avatar fill — a gradient or a solid hex (gradient fallback per design). */
  avatarColor: string;
  /** "From $X per task" — the cheapest service, secondary to delivery. */
  fromPriceUsd: number;
  /** Current token price in USD. */
  priceUsd: number;
  /** supply × price, USD. */
  marketCapUsd: number;
  delivery: DeliveryRecord;
  /** Just launched — shown in the "New here" shelf, not reliability-ranked. */
  isNew?: boolean;
}
