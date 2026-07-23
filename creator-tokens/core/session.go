package core

import (
	"math/big"
	"strings"
)

// Book — the magi-consult session escrow (access-credit utility, 2026-07-21;
// Ruling 11 of DESIGN-HANDOFF).
//
// A session booking IS an escrowed ask against the creator's SESSION price
// instead of the ask face. It reuses the audited ask escrow (ask.go) UNCHANGED:
//
//	Book     opens the escrow  (this file)  == Ask,   reading kSessionPrice
//	deliver  resolves + pays   == core.Answer          (NO new code)
//	reclaim  refunds on no-show == core.Reclaim         (NO new code)
//
// Answer and Reclaim operate on ANY escrow seq generically — they read the
// packed escrowRec (credits/commission/deadline/status/hashes), which carries no
// notion of "ask" vs "session" — so a booking flows through the EXACT same
// disjoint-window state machine an ask does: creator delivers before the
// deadline (credits release to them, held commission books to treasury) or, past
// deadline+ReclaimGrace, the booker reclaims credits AND commission in full. No
// on-chain CONFIRMED sub-state and no buyer-confirmation gate (Ruling 11:
// withholding confirmation would be a creator-griefing lever; the booker's
// protection is the deadline + full reclaim + the public delivery record).
// contentHash commits to the off-chain session brief; Answer's answerHash is the
// delivery attestation. Scheduling is coordinated off-chain on Lumen; the on-
// chain deadline is the delivery horizon, bounded to MaxAskDeadline (30d) like
// any ask — a horizon beyond 30d needs a session-specific bound (a documented
// v2 item, not built here).
//
// Book shares kSeq(creator)/kEscrow(creator, seq) with Ask, so a creator's asks
// and sessions occupy ONE escrow-sequence space. This is deliberate and safe:
// Answer/Reclaim resolve by (creator, seq) regardless of origin, the money math
// is identical, and the on-chain record intentionally does not distinguish the
// two — the frontend/indexer tags kind by the off-chain content the hash
// commits to. Both count toward the creator's single delivery record, which is
// correct: a session delivered and a question answered are both deliveries.
//
// Every manipulation defense is Ask's, verbatim (see Ask's own doc): the
// settlement rate is derived internally, creditsSpent is bounded by the booker's
// signed maxCredits, and commissionHbdPaid must EXACTLY equal
// commissionOwedFor(sessionPrice) at execution. Book is a NEW inflow -> gated
// ACTIVE/OVERDUE via RequireInflowOpen. This function is intentionally a near-
// duplicate of Ask rather than a refactor of it, so the audited Ask path stays
// byte-for-byte untouched.
type BookResult struct {
	Seq           uint64
	CreditsSpent  *big.Int
	CommissionHbd *big.Int
	RateUsed      *big.Int
}

func Book(s Store, caller, creator string, block uint64, maxCredits, commissionHbdPaid *big.Int, contentHash string, deadlineBlocks uint64) (*BookResult, error) {
	if !validAccount(caller) {
		return nil, newErr(ErrInput, "invalid caller")
	}
	if !validAccount(creator) {
		return nil, newErr(ErrInput, "invalid creator")
	}
	if contentHash == "" {
		return nil, newErr(ErrInput, "empty content hash")
	}
	if strings.Contains(contentHash, "|") {
		return nil, newErr(ErrInput, "contentHash must not contain '|'")
	}
	if maxCredits == nil || !mGt(maxCredits, mZero()) {
		return nil, newErr(ErrInput, "maxCredits must be > 0")
	}
	if commissionHbdPaid == nil || commissionHbdPaid.Sign() < 0 {
		return nil, newErr(ErrInput, "invalid commission amount")
	}
	if deadlineBlocks < MinAskDeadline || deadlineBlocks > MaxAskDeadline {
		return nil, newErr(ErrInput, "deadline out of band")
	}

	// New booking is an inflow: gated ACTIVE/OVERDUE (this is Book's only phase
	// check — deliver/reclaim are Answer/Reclaim, which are deliberately never
	// phase-gated, so an in-flight booking always resolves).
	if err := RequireInflowOpen(s, creator, block); err != nil {
		return nil, err
	}

	price := getMoney(s, kSessionPrice(creator))
	if !mGt(price, mZero()) {
		return nil, newErr(ErrState, "creator does not offer sessions")
	}

	// Settlement derivation + RULING C guards — the SAME settleSpend Ask and
	// Unlock use (RULING C3: one derivation for every token-settled service;
	// a Book that priced off a different window than an Ask would just move
	// the manipulation to whichever consumer is softest). Refusal is a typed
	// revert on this new-service INFLOW; it gates no funds — the escrow
	// resolution half (Answer/Reclaim) never consults settlement at all.
	q, err := settleSpend(s, creator, block, price)
	if err != nil {
		return nil, err
	}
	rate := q.Rate
	creditsSpent := q.Credits
	// Slippage guard against a creator-controlled session-price spike under
	// producer-chosen intra-block ordering — the identical attack and cap Ask's
	// maxCredits closes for face (see Ask's doc): SetSessionPrice is banded
	// 2x/7d but a single band-legal move sandwiched around a pending booking is
	// still enough to overspend without this cap.
	if mGt(creditsSpent, maxCredits) {
		return nil, newErr(ErrInput, "creditsSpent exceeds maxCredits")
	}
	if owed := commissionOwedFor(price); commissionHbdPaid.Cmp(owed) != 0 {
		return nil, newErr(ErrBalance, "commission must exactly equal commissionOwedFor(sessionPrice) at execution (not more, not less)")
	}

	bal := getMoney(s, kBal(creator, caller))
	if mLt(bal, creditsSpent) {
		return nil, newErr(ErrBalance, "insufficient credits")
	}
	// Chokepoint debit (holdclock.go): same escrow-out shape and reasoning
	// as Ask's own debit (ask.go) — the escrowed tokens leave the balance,
	// and (ET-2 fix, 2026-07-22, hold-clock half kept by RULING K) the
	// booker's hold clock is RECORDED in the escrow so an unanswered booking
	// that is later reclaimed returns the tokens exactly as they left, age
	// intact. A booking that delivers nothing must cost the booker nothing.
	// The booker's remaining position keeps its own clock either way. RULING K
	// deleted the cost basis, so only the age is recorded.
	acqAtEscrow := holderAcqBlock(s, creator, caller)
	if err := debitBalance(s, creator, caller, creditsSpent); err != nil {
		return nil, err // unreachable given the check above; defense-in-depth
	}

	seq := getU64(s, kSeq(creator))
	deadline := block + deadlineBlocks
	// Commission is HELD in the escrow (not booked to treasury yet) — booked on
	// deliver (Answer) or returned in full on reclaim (Reclaim), exactly as an
	// ask's is. contentHash = the session brief; answerHash filled by Answer.
	saveEscrow(s, creator, seq, escrowRec{
		asker: caller, credits: creditsSpent, deadline: deadline,
		status: askPending, contentHash: contentHash, answerHash: "",
		commissionHbd: commissionHbdPaid,
		acqBlock:      acqAtEscrow,
	})
	setU64(s, kSeq(creator), seq+1)

	return &BookResult{Seq: seq, CreditsSpent: creditsSpent, CommissionHbd: commissionHbdPaid, RateUsed: rate}, nil
}
