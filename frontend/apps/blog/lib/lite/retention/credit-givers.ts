/**
 * The anti-farm bound on received engagement — a direct port of the ranking engine's
 * `VoterTrust.credited_breadth` (`/mnt/o/Lumen/recsys/recsys/core/vote_signal.py`).
 *
 * ★ THE PROBLEM THIS SOLVES IS ALREADY SOLVED ONCE, NEXT DOOR.
 *
 * The engagement arm counts DISTINCT OTHER USERS who voted, reblogged or replied to
 * you. On Hive, distinct-giver count is expensive to manufacture: each giver is an
 * account that costs resource credits or money. On Lumen a lite account costs one
 * captcha solve, so distinct-giver count is purchasable at effectively zero marginal
 * cost, and a raw count would let an attacker with a browser tab buy the top rung.
 *
 * The recommender hit exactly this and fixed it, and it is worth quoting what it
 * measured rather than restating the theory: before the fix a spam post's feed position
 * climbed with every alt (11 -> 8 -> 5 for 3 / 10 / 20 alts); after it, position is FLAT
 * at 17 across all three, with honest-viewer nDCG@20 unchanged (0.4099 vs 0.4098). The
 * shape of that fix is a BUDGET, not a ban, and the distinction is load-bearing.
 *
 * WHY A BUDGET AND NOT A BAN. The project already broke and undid the ban version: if
 * new accounts contribute nothing, a genuine newcomer's first upvote counts for
 * nothing, and on a platform whose whole population is new that zeroes the arm for
 * everyone. `unknownFree >= 1` guarantees the first unknown giver always counts.
 *
 *     credited = vouchedCount + min(unknownCount, budget)
 *     budget   = min(unknownFree + unknownPerVouched * vouchedCount, unknownMax)
 *
 * A swarm of fresh alts has zero vouched members, so its budget is exactly `unknownFree`
 * — 40 alts credit 1, the same as 1 alt does. The arm stops responding to more alts
 * entirely, which is the property being bought. `unknownPerVouched` lets a genuinely
 * well-received user absorb proportionally more real newcomers, and grants the bare-alt
 * attack nothing (zero vouched -> the slope multiplies zero). `unknownMax` caps that
 * growth, because the recsys measured the uncapped budget reaching 31 units at 10
 * vouched engagers and ~300 once a follow graph existed — a ceiling that scales with
 * your own popularity is a ceiling an attacker rents by first getting popular honestly.
 *
 * Monotone non-decreasing in the giver set: adding a giver never LOWERS your credit, so
 * honest users keep the "more people liking you never hurts" guarantee.
 */

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Newcomer floor. MUST stay >= 1: below that, a genuine new user's first upvote stops
 * counting, which is the regression this project already made once and reverted. Mirrors
 * `VoteSignalConfig.unknown_free = 1.0`.
 */
export const UNKNOWN_FREE = Math.max(1, envNum('LITE_RETENTION_UNKNOWN_FREE', 1));

/** Extra unknown budget per vouched giver. Mirrors `unknown_per_vouched = 2.0`. */
export const UNKNOWN_PER_VOUCHED = Math.max(0, envNum('LITE_RETENTION_UNKNOWN_PER_VOUCHED', 2));

/** Hard ceiling on the unknown budget. `<= 0` disables. Mirrors `unknown_max = 10.0`. */
export const UNKNOWN_MAX = envNum('LITE_RETENTION_UNKNOWN_MAX', 10);

/**
 * What makes a giver VOUCHED — i.e. what makes their engagement count in full.
 *
 * The recsys draws this line at a weekly graph-cred snapshot, which does not exist on
 * the Postgres side. The Lumen-native equivalent uses the two facts the ladder already
 * trusts about an account, applied to the GIVER instead of the receiver:
 *
 *   * account age >= VOUCHED_MIN_AGE_DAYS — uncompressible calendar time, the one
 *     input a captcha farm cannot skip, and
 *   * VOUCHED_MIN_ACTIVE_DAYS distinct UTC days of their own activity — presence that
 *     must be spread across separate calendar days, so it cannot be scripted in one
 *     sitting either.
 *
 * The defaults (7 days old, 3 active days) are not picked freehand — they are exactly
 * the two edges that grant arm index 3 in `bands.ts`, i.e. rung 4, ASH, THE TURN. So the
 * rule states itself: A GIVER'S ENGAGEMENT COUNTS IN FULL ONCE THE GIVER HAS THEMSELVES
 * MADE THE TURN, on both of the arms that cannot be bought. Everyone below that line
 * still counts — out of a budget rather than one-for-one — because a newcomer's first
 * upvote must never be worth zero.
 *
 * WHAT THIS COSTS AN ATTACKER — MEASURED, not argued. The three runs below were
 * executed against the real QA database inside a rolled-back transaction, using the
 * shipped SQL and the real `computeLiteRetention`:
 *
 *   1. 40 free sock accounts (created today, no history) upvote a maxed-out target:
 *        raw 40 givers -> vouched 0, unknown 40, budget 1, CREDITED 1 -> rung 4 (Ash).
 *      The 2nd through 40th sock bought exactly nothing. This is the property being
 *      purchased, and it is the whole point: the arm stops responding to alts.
 *
 *   2. 10 AGED socks (30 days old, 3 active days each) + 30 free ones:
 *        raw 40 -> vouched 10, unknown 30, budget 10, CREDITED 20 -> rung 9 (Lumen).
 *      ★ SO THIS BOUND ALONE DOES NOT STOP A PATIENT ATTACKER, AND SAYING OTHERWISE
 *      WOULD BE THE LIE. Ten accounts clearing `VOUCHED_MIN_AGE_DAYS` age in PARALLEL,
 *      so the real cost is ~7 wall-clock days and ten captchas. Anyone reading this
 *      before raising the ladder's stakes should know that number.
 *
 *   3. THE SAME 40 givers, against a 2-day-old target:
 *        credited 20 -> rung 2 (Abyss), binding arm = TENURE.
 *      This is what actually holds. The farmed engagement arm is capped by the
 *      attacker's OWN tenure and presence, so farming buys a CEILING, never a rank.
 *
 * The residual worth watching, stated plainly: a genuinely long-lived, genuinely active
 * account (240 days old, active 45 of the last 60) can manufacture the AUDIENCE arm it
 * would otherwise need real readers for, with ten patiently-aged socks. Everything
 * cheaper than that is already dead. Tightening levers, in order of cost:
 * `LITE_RETENTION_VOUCHED_MIN_AGE_DAYS` and `LITE_RETENTION_VOUCHED_MIN_ACTIVE_DAYS`
 * (free, one env change), then raising `LITE_RETENTION_ENGAGEMENT_G6`, and finally the
 * real fix — defining vouched RECURSIVELY, as the recsys does ("an account others have
 * genuinely engaged"), which makes each sock need its own giver. That last one is
 * deliberately not done here: it costs a self-join per giver and this route's contract
 * is one indexed query in milliseconds. The proxy is weaker than the thing it models,
 * and this comment is where that is admitted rather than where it is hidden.
 */
export const VOUCHED_MIN_AGE_DAYS = envNum('LITE_RETENTION_VOUCHED_MIN_AGE_DAYS', 7);
export const VOUCHED_MIN_ACTIVE_DAYS = envNum('LITE_RETENTION_VOUCHED_MIN_ACTIVE_DAYS', 3);

/**
 * Cost bound on scanning givers. Well above the top engagement edge (20 credited), so it
 * never changes an honest answer; it exists so one very popular account cannot turn this
 * route into an unbounded scan. When it bites, the response says so rather than pretending
 * the number is complete.
 */
export const GIVER_SCAN_LIMIT = Math.max(1, envNum('LITE_RETENTION_GIVER_SCAN_LIMIT', 500));

export interface GiverCredit {
  /** Givers established enough to count one-for-one. */
  vouched: number;
  /** Everyone else who engaged you — counted, but out of `budget`. */
  unknown: number;
  /** How many of the `unknown` the budget could absorb. */
  budget: number;
  /** `vouched + min(unknown, budget)` — the ONLY number the engagement band may see. */
  credited: number;
}

export function creditGivers(vouched: number, unknown: number): GiverCredit {
  const v = Math.max(0, vouched);
  const u = Math.max(0, unknown);
  let budget = UNKNOWN_FREE + UNKNOWN_PER_VOUCHED * v;
  if (UNKNOWN_MAX > 0) budget = Math.min(budget, UNKNOWN_MAX);
  return { vouched: v, unknown: u, budget, credited: v + Math.min(u, budget) };
}
