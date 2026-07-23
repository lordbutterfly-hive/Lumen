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
  /** 0–100, completion rate. */
  completionPct: number;
  /** Human "usually within ~6h". */
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
