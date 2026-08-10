/**
 * ════ VOTE-BREADTH TRUST FLOORS — the anti-farm bound on the engagement arm ════
 *
 * ★ WHY THIS IS A MODULE AND NOT A FUNCTION INSIDE THE ROUTE (2026-08-08, second
 * pass). It used to live in `app/api/streak/[user]/route.ts` with the comment
 * "NOT exported: a Next App Router route module may only export the HTTP method
 * handlers, so exporting this for testability is a build error, not a style
 * choice." The premise is true and the conclusion was wrong: the fix for "a route
 * module cannot export this" is to move the pure part OUT of the route module,
 * not to ship the single most attack-relevant function in the feature with zero
 * test coverage. It is the only anti-farm bound on the arm that decides the byline
 * emblem, and it went in untested. Now it is a pure module beside the ladder it
 * feeds, and `lib/__tests__/ladder.test.ts` asserts every property claimed below.
 *
 * ★ THIS FILE GOT MORE LOAD-BEARING ON 2026-08-09, NOT LESS. The credited count used
 * to be a MULTIPLIER on a reputation proxy — `e * (0.4 + 0.6 * min(givers/80, 1))` —
 * so the worst a broken floor could do was scale an inherited number. Reputation is
 * out of the arm now and `creditedGivers` IS the engagement keystone
 * (compute-league.ts's ENGAGEMENT_ARM reads it directly), which means these floors are
 * the ONLY thing between a swarm of free identities and the public mark.
 *
 * Measured against the shipped tables: the mark sits at 40 credited givers, which is 25
 * established givers once the unknown budget is accounted for, which is ~1,563 HP of
 * real stake (ladder.test.ts §7 asserts the figure). Before the floors existed this was
 * counted as "any account that clicked upvote", with no stake, age or reputation floor
 * of any kind — and a Lumen Lite signup is free, so the mark cost $0.
 *
 * ★ WHY THE FLOOR IS BUILT ON RSHARES AND NOTHING ELSE. Checked against the live
 * payload rather than assumed: `database_api.list_votes` returns
 * voter/rshares/weight/vote_percent/last_update/num_changes and NO reputation, and
 * `getActiveVotes` fills `IVote.reputation` with a hardcoded `0` (see
 * packages/transaction/lib/hive-api.ts — "Not available in database_api.list_votes").
 * Account age and reputation would each cost one extra API call PER VOTER, on a
 * route that already truncates its own feed walk against a 20s budget. rshares is
 * the only trust-bearing field on the wire, so it is what the floors read.
 *
 * The shape is lifted from recsys `core/vote_signal.py` (`_ORGANIC_VOTER_MIN_RSHARES`
 * dust floor + `VoterTrust.credited_breadth`'s budgeted unknown tier), which solved
 * this exact problem for the ranking feed. Stake stands in for that system's
 * graph-cred, which is the honest weakening to state out loud: stake proves COST,
 * not that anyone genuinely engaged. It cannot tell a funded alt from a real small
 * account — which is precisely why unknowns are BUDGETED rather than banned.
 *
 * ★★ WHAT THIS BOUND ACTUALLY COSTS AN ATTACKER — MEASURED, NOT ASSERTED, AND THE
 * PRICE IS NOW FLAT.
 *
 * Under the reputation proxy the mark had a different price for every account, because
 * breadth only scaled a number the holder had inherited. Computed from the tables that
 * shipped then:
 *
 *   target reputation │ established givers for the MARK │ HP behind them
 *   ──────────────────┼────────────────────────────────┼───────────────
 *          88 (top)   │                8               │    ~500 HP
 *          80         │               19               │  ~1,190 HP
 *          70         │               38               │  ~2,375 HP
 *        <=60         │      UNREACHABLE at any breadth, ever
 *
 * With the arm measured, the mark is 40 credited givers for everybody: 25 established
 * givers, ~1,563 HP (asserted in ladder.test.ts §7 — the assertion is what caught an
 * earlier estimate of "1,500-2,500, higher than before", which was wrong at the top of
 * the old range). So the comparison is not "dearer", it is:
 *
 *   - the accounts that got the mark most cheaply now pay 3x more,
 *   - the accounts that could never get it at all now can, and
 *   - the price no longer depends on a number the holder cannot influence.
 *
 * Two things make it softer than it looks and are stated rather than hidden: a giver is
 * classified by their STRONGEST vote across the sample, so the stake need only exist at
 * the moment of one vote; and Hive HP is delegable, so the stake can be rented and
 * recalled rather than bought. The sample widened from 3 posts to 8 on 2026-08-09,
 * which makes the first of those slightly harder to arrange and nothing else.
 */

/** The per-vote fields this bound actually reads. See getActiveVotes → IVote. */
export interface VoteLike {
  voter?: string;
  rshares?: number | string;
}

/**
 * Dust floor. A vote at or below this registers no breadth at all. Same value as
 * recsys's `_ORGANIC_VOTER_MIN_RSHARES`. ≈ 0.3 HP at a full-weight vote, measured
 * at ~3.2e7 rshares per HP from live votes on 2026-08-08.
 *
 * ATTACKER COST: below this line a vote is free, so the credit for it is zero.
 * Also excludes negative rshares — a DOWNVOTE used to buy the author breadth.
 * Non-disruptive to real accounts: measured live on 2026-08-08 against four
 * established accounts through the shipped route, it rejects 51 of 1,616 voters
 * (@blocktrades), 14 of 1,008 (@taskmaster4450), 17 of 701 (@acidyo) and 24 of
 * 1,575 (@gtg) — 1–3%.
 */
export const VOTER_MIN_RSHARES = 1e7;

/**
 * The "established giver" bar: at or above this, a voter counts in full.
 * ≈ 62 HP behind a full-weight vote.
 *
 * Chosen empirically, not guessed: at 5e9 a real account (@rafaelaquino, 55
 * givers) lost its rung; at 2e9 all 18 sampled real accounts hold station. Live
 * re-measurement on 2026-08-08 confirms it is not selective on Hive — 1,097 of
 * 1,616 sampled voters on @blocktrades clear it — which is the honest reading of
 * "62 HP is an ordinary amount of Hive stake", and the reason the emblem price in
 * the header block is in the hundreds of HP rather than the thousands.
 */
export const ESTABLISHED_VOTER_MIN_RSHARES = 2e9;

/**
 * ★ THE NEWCOMER INVARIANT. Unknown (above dust, below established) givers are
 * always credited for at least this many. A genuine new supporter's first upvote
 * MUST still count — recsys broke exactly this once and had to undo it. A bare
 * sock swarm hits the same floor, because with no established giver the budget
 * never grows: 80 socks buy 1, not 80.
 */
export const UNKNOWN_GIVER_FREE = 1;

/**
 * How much the unknown budget grows per ESTABLISHED giver (recsys's
 * `unknown_per_vouched`). An account with genuine established support really does
 * attract more real newcomers, so it may absorb proportionally more of them. This
 * grants the bare-alt attack nothing — with zero established givers the budget is
 * exactly UNKNOWN_GIVER_FREE.
 */
export const UNKNOWN_GIVER_PER_ESTABLISHED = 2;

/**
 * Hard ceiling on the unknown budget, however established the account is — recsys's
 * `unknown_max`, added there on 2026-08-06 for this same reason. Without it the
 * budget grows without bound in the target's OWN popularity, and since free
 * identities cost an attacker nothing, the more genuine support an account has the
 * more free breadth it could absorb on top. 15 is the smallest value that leaves
 * every one of the 18 sampled real accounts on its existing rung.
 */
export const UNKNOWN_GIVER_MAX = 15;

/** Giver breadth with its trust split shown, so the number can be explained. */
export interface GiverBreadth {
  /** What feeds the league's breadth arm. */
  credited: number;
  /** Distinct voters at or above ESTABLISHED_VOTER_MIN_RSHARES — credited in full. */
  established: number;
  /** Distinct voters above dust but below that bar. */
  unknown: number;
  /** How many of `unknown` the budget actually credited. */
  unknownCredited: number;
  /** Distinct voters rejected by the dust floor (incl. zero and downvotes). */
  dustRejected: number;
  /** The author's own vote on their own post, if present. Never credited. */
  selfExcluded: number;
}

/**
 * Credit distinct givers with a dust floor and a budgeted unknown tier.
 *
 * Monotone non-decreasing in the voter set — adding a voter can never LOWER the
 * credit — so "more independent people never hurts" still holds for an honest
 * account, exactly as in recsys's `credited_breadth`.
 *
 * ★ `self` IS REQUIRED, AND IT IS NOT DEFENSIVE PROGRAMMING (found 2026-08-08).
 * This function had no author filter, so a self-upvote was counted as a distinct
 * giver — which contradicts two things the project has already committed to in
 * writing. (1) The shipped /ranks copy, verbatim: "What does not move you. At
 * all. … Voting for yourself." (2) The Lumen-native implementation of the very
 * same arm, which excludes it in SQL (`v.voter_user_id <> $1`,
 * lib/lite/retention/facts-query.ts) and argues the case at length in
 * lib/lite/content/engagement-target.ts: a vote that only feeds ranking "has no
 * legitimate use to protect". Two implementations of one product disagreeing
 * about whether you may vote yourself up the ladder is the disagreement, not the
 * size of the effect. The effect is small on its own — one giver out of the 80
 * that saturate breadth, worth +0.6 points of the multiplier — but it is the
 * first giver, and the first giver is the one the newcomer floor is sized around.
 */
export function creditedGivers(votes: VoteLike[], self: string): GiverBreadth {
  const author = self.toLowerCase();
  // A voter is classified by their STRONGEST observed vote across the sample: a
  // voter is established if they ever showed established stake, so appearing on
  // two sampled posts can never demote them.
  const best = new Map<string, number>();
  const seen = new Set<string>();
  let selfExcluded = 0;
  for (const v of votes) {
    const voter = v.voter;
    if (!voter) continue;
    if (voter.toLowerCase() === author) {
      selfExcluded = 1;
      continue;
    }
    seen.add(voter);
    // Coerced because some nodes serialise large integers as strings. A
    // non-numeric value is untrusted input and must not be read as stake.
    const rshares = Number(v.rshares);
    if (!Number.isFinite(rshares) || rshares < VOTER_MIN_RSHARES) continue;
    const prev = best.get(voter);
    if (prev === undefined || rshares > prev) best.set(voter, rshares);
  }

  let established = 0;
  let unknown = 0;
  for (const rshares of best.values()) {
    if (rshares >= ESTABLISHED_VOTER_MIN_RSHARES) established++;
    else unknown++;
  }

  const budget = Math.min(
    UNKNOWN_GIVER_FREE + UNKNOWN_GIVER_PER_ESTABLISHED * established,
    UNKNOWN_GIVER_MAX
  );
  const unknownCredited = Math.min(unknown, budget);
  return {
    credited: Math.floor(established + unknownCredited),
    established,
    unknown,
    unknownCredited,
    dustRejected: seen.size - best.size,
    selfExcluded
  };
}
