import type { AskStatus, DeliveryWindow, MarketPhase, QuoteOracleStatus } from './types';

// Deliberately NOT copy. SPEC §2.3: "All strings via t() under a creator_keys.*
// namespace; no inline user-facing text" and the repo CLAUDE.md rule this task
// restates verbatim — and the visual design for this feature is being built in
// a separate track right now, so hardcoded English here (as
// prediction-market/labels.ts does, with its own "TODO: move to i18n" admission)
// would both violate that rule and collide with whatever copy the visual track
// writes into locales/en/common_blog.json under this same namespace.
//
// What this file actually owns: the single canonical map from each domain enum
// value (types.ts) to its i18n key path, so the data layer and every future UI
// component agree on one key per state instead of each re-deriving its own
// string switch. Components call e.g. t(PHASE_LABEL_KEY.OVERDUE) — the key
// exists whether or not the locale JSON has been populated yet.

export const CREATOR_TOKENS_I18N_NAMESPACE = 'common_blog';
const NS = 'creator_keys';

export const PHASE_LABEL_KEY: Record<MarketPhase, string> = {
  ACTIVE: `${NS}.phase.active`,
  OVERDUE: `${NS}.phase.overdue`,
  FROZEN: `${NS}.phase.frozen`,
  CLOSED: `${NS}.phase.closed`,
  UNKNOWN: `${NS}.phase.unknown`
};

export const ASK_STATUS_LABEL_KEY: Record<AskStatus, string> = {
  awaiting: `${NS}.ask_status.awaiting`,
  // The dead zone (deadline < block <= deadline+ReclaimGrace) — split out of
  // `awaiting` 2026-07-20 so the UI never shows an answerable-looking state
  // the chain would actually revert (see types.ts's AskStatus doc).
  expired: `${NS}.ask_status.expired`,
  answered: `${NS}.ask_status.answered`,
  reclaimable: `${NS}.ask_status.reclaimable`,
  reclaimed: `${NS}.ask_status.reclaimed`,
  // The creator's free "no" — a terminal state distinct from `reclaimed` on
  // purpose (see types.ts's AskStatus doc): both return the money, only one is
  // a black mark against the delivery record.
  declined: `${NS}.ask_status.declined`
};

export const DELIVERY_OUTCOME_LABEL_KEY: Record<DeliveryWindow['outcome'], string> = {
  answered: `${NS}.delivery_outcome.answered`,
  missed: `${NS}.delivery_outcome.missed`,
  pending: `${NS}.delivery_outcome.pending`
};

export const QUOTE_ORACLE_STATUS_LABEL_KEY: Record<QuoteOracleStatus, string> = {
  ok: `${NS}.quote_oracle.ok`,
  insufficient_observations: `${NS}.quote_oracle.insufficient_observations`,
  insufficient_span: `${NS}.quote_oracle.insufficient_span`,
  stale: `${NS}.quote_oracle.stale`,
  deviation_capped: `${NS}.quote_oracle.deviation_capped`,
  unavailable: `${NS}.quote_oracle.unavailable`,
  // H2 + H1 (2026-08-31): no posted price, and settleSpend's four guards.
  no_price_set: `${NS}.quote_oracle.no_price_set`,
  market_too_small: `${NS}.quote_oracle.market_too_small`,
  price_below_floor: `${NS}.quote_oracle.price_below_floor`,
  price_above_ceiling: `${NS}.quote_oracle.price_above_ceiling`,
  spend_cap: `${NS}.quote_oracle.spend_cap`
};

// Banned-word list from SPEC §2.3, kept here (not enforced at runtime — no
// lint rule exists for it) so the constraint travels with the code that
// produces the numbers those words would describe: invest, investment,
// return, ROI, APY, yield, profit, shares, dividend, "get in early", price
// targets. Never surface these regardless of what a future locale key is named.
