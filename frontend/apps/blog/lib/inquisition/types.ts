/**
 * ════ WHAT THE MODE IS ALLOWED TO SAY ════
 *
 * Every shape here carries a `partial` or an `asOf`, and that is deliberate. The
 * spec's hardest rule is "receipts or it is cut": a number nobody can trace gets
 * removed from the board. A type that cannot express "we only counted part of it"
 * pushes the caller into rounding an unknown up to a fact, so these types refuse to
 * be that type.
 *
 * Shared between server and client, so no `server-only` here — it is types and two
 * pure functions, no endpoints, no secrets.
 */

/** A count we can stand behind, or one we cannot. Never a bare number. */
export interface Bounded {
  value: number;
  /** True when a page cap stopped the walk, so `value` is a floor, not a total. */
  partial: boolean;
  /** When this was computed, ISO. Every figure on screen shows its own age. */
  asOf: string;
}

export interface BlacklistMark {
  /** The account that published the list. Never merged with the others. */
  publisher: string;
  /** Publishers use both list types and they mean different things. */
  kind: 'blacklisted' | 'muted';
  /** Where a listed account goes to argue. May be down; show it anyway. */
  appealUrl: string | null;
}

export interface SteemActivity {
  /** Posts published to Steem AFTER the Hive hardfork. */
  postsSinceFork: number;
  /** ISO date of the most recent one, or null when there are none. */
  lastPost: string | null;
  partial: boolean;
  asOf: string;
  /**
   * ★ HOW MANY UPSTREAM REQUESTS THIS ANSWER ACTUALLY COST. The board build spends a
   * fixed budget against api.steemit.com, and it cannot spend one it cannot count. A
   * cache hit reports the cost of the walk that produced it, which overstates the live
   * cost — the safe direction.
   */
  requests: number;
}

export interface KeRatio {
  /** Σ(author + curation rewards) in HP ÷ HP held. */
  value: number | null;
  rewardsHp: number;
  hpHeld: number;
  band: KeBand;
  partial: boolean;
  asOf: string;
}

/**
 * ★★ THE BAND WORDS SHIP BARE (owner, 2026-09-19: "dont add descriptions for
 * extractive or net holder. keep descriptions to ourselves").
 *
 * So the thresholds and the caveat live HERE, in the code, and no version of this
 * paragraph reaches the screen. For the record, because whoever changes these numbers
 * needs it: KE is rewards taken ÷ stake held, which reads someone living off their
 * payouts and a farm draining the pool as the SAME number. It is evidence of cash-out
 * behaviour, never of abuse, and it must never feed an automatic action — there is no
 * write path in this feature for it to feed.
 */
export type KeBand = 'net holder' | 'ordinary' | 'extractive' | 'cashing out' | 'unknown';

export function keBand(value: number | null): KeBand {
  if (value === null || !Number.isFinite(value)) return 'unknown';
  if (value < 1) return 'net holder';
  if (value < 3) return 'ordinary';
  if (value <= 10) return 'extractive';
  return 'cashing out';
}

export interface AccountRecord {
  account: string;
  ke: KeRatio;
  downvotesReceived: Bounded;
  /** Distinct accounts behind those downvotes. 31 from 9 is a dispute, not a consensus. */
  downvoteVoters: Bounded;
  mutedBy: Bounded;
  blacklists: BlacklistMark[];
  /** ISO date the account was created, for the age floor and the profile strip. */
  created: string | null;
  asOf: string;
}

/** The Hive hardfork. Everything on Steem after this is the interesting number. */
export const HIVE_FORK_ISO = '2020-03-20T00:00:00';

export function nowIso(): string {
  return new Date().toISOString().slice(0, 19);
}
