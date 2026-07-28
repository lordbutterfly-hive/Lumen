package core

// rating.go — the buyer's rating of a delivered job (USER RULING, 2026-07-28).
//
// WHY THIS EXISTS. The contract deliberately knows NOTHING about the work
// itself: no question text, no answer text, no deliverable. The two parties
// arrange delivery between themselves, and `Answer` is the creator saying "this
// is done" — which pays them. That is UNILATERAL by design: a creator can mark
// a job delivered having done nothing, and the contract cannot tell.
//
// The rating is the counterweight, and it is the ONLY one. There is no dispute,
// no arbitration, no clawback — those need a judge, and there isn't one. What
// there is instead: the buyer records what actually happened, permanently, and
// a creator who takes money without delivering watches their own token's
// reputation (and therefore its price) fall. The discipline is economic, not
// procedural.
//
// TWO HARD RULES, both structural rather than conventional:
//
//  1. A RATING CAN NEVER GATE FUNDS. Not a payout, not a refund, not a reclaim,
//     not a sale. This file writes one counter and emits one event; it is not
//     read by RequireInflowOpen, by Phase, or by any money path, and it must
//     never be. Every guardrail in this contract already says non-payment and
//     non-delivery must not trap anyone's money — a SUBJECTIVE score gating
//     funds would be strictly worse than either, because it would hand one
//     party a lever over the other's balance.
//
//  2. ONLY A PAYING BUYER OF A DELIVERED JOB CAN RATE, ONCE. That is what makes
//     it sybil-resistant without any identity machinery: a fake rating costs a
//     real escrow at the creator's own posted price, paid to that creator. The
//     attack is buying the thing you are lying about.
//
// WHAT IS DELIBERATELY NOT RATEABLE. A reclaim (the creator went silent) and a
// decline (the creator said no) are BOTH already recorded objectively by the
// delivery gate — misses convict, declines are neutral. Letting a buyer also
// attach a subjective score to those would double-count the same event and,
// worse, would let anyone who can open an escrow attach a 1-star to a creator
// who never took their money. Rating is scoped to jobs that were actually
// delivered and actually paid for.

// Score bounds. A 1-5 scale, stored as the raw integer — no half-stars, no
// zero: 0 is reserved as "not rated", which is what makes the once-only check
// a simple non-zero test rather than a second key.
const (
	MinRating uint64 = 1
	MaxRating uint64 = 5
)

// Rate records the asker's score for one delivered escrow.
//
// Infallible for the creator: nothing here can be refused in a way that affects
// their money, and nothing here runs on a fund path.
func Rate(s Store, caller, creator string, seq, score uint64) error {
	if caller == "" {
		return newErr(ErrAuth, "empty caller")
	}
	if score < MinRating || score > MaxRating {
		return newErr(ErrInput, "score must be 1-5")
	}

	rec, ok := loadEscrow(s, creator, seq)
	if !ok {
		return newErr(ErrNotFound, "no such escrow")
	}
	// The BUYER rates, and only the buyer — not the caller who happened to push
	// the transaction, and never the creator. rec.asker is the account that
	// actually paid; it is recorded at Ask time and cannot be edited afterwards.
	if caller != rec.asker {
		return newErr(ErrAuth, "only the buyer of this job can rate it")
	}
	// Delivered jobs only — see the file doc for why a reclaim and a decline are
	// deliberately excluded.
	if rec.status != askAnswered {
		return newErr(ErrState, "only a delivered job can be rated")
	}
	// A self-dealt job is excluded for the same reason it is excluded from the
	// delivery counters: a creator rating their own work is not evidence, and
	// leaving it in would make five stars purchasable from yourself at cost.
	if rec.asker == creator {
		return newErr(ErrState, "a creator cannot rate their own job")
	}
	if getU64(s, kAskRating(creator, seq)) != 0 {
		return newErr(ErrState, "this job has already been rated")
	}

	setU64(s, kAskRating(creator, seq), score)
	// Running aggregate, so a reader can show a creator's standing without
	// replaying every escrow. It is a CONVENIENCE, not the source of truth — the
	// per-escrow scores above are, and the indexer rebuilds the average from the
	// events either way.
	setU64(s, kRatingCount(creator), getU64(s, kRatingCount(creator))+1)
	setU64(s, kRatingSum(creator), getU64(s, kRatingSum(creator))+score)
	return nil
}

// RatingOf reports one escrow's score, or 0 when it has not been rated.
func RatingOf(s Store, creator string, seq uint64) uint64 {
	return getU64(s, kAskRating(creator, seq))
}

// CreatorRating reports (sum, count) so a caller can render an average without
// this package inventing a rounding convention for it. count == 0 means
// UNRATED, which a UI must show as "no ratings yet" and must never rank as
// equivalent to a good score — the same missing-is-not-perfect rule the
// delivery record already follows.
func CreatorRating(s Store, creator string) (sum, count uint64) {
	return getU64(s, kRatingSum(creator)), getU64(s, kRatingCount(creator))
}
