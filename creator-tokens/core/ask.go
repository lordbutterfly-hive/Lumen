package core

import (
	"math/big"
	"strconv"
	"strings"
)

// Ask / Answer / Reclaim — the escrowed-ask lifecycle (API.md, SPEC §1.1,
// §1.3b, §1.7.3, §1.7.5).
//
// Ask spends credits (never HBD) at the prevailing settlement rate
// (settleSpend — settlement.go, RULING C) into an escrow record. The creator either Answers
// before the deadline (credits release to them, and the HBD commission held
// in escrow books to the treasury — delivered service) or, past
// deadline+ReclaimGrace, Reclaim pays them back to the asker in full:
// credits AND the commission (SPEC §1.7.2 rule 4 / I5 — see Reclaim's own
// doc). Reclaim is PERMISSIONLESS once that window opens (H1 defect fix,
// 2026-07-21) — anyone may push it, but it can only ever pay the asker,
// never the caller, the same shape refund.go's RefundHolder already has.
//
// I6 (ordering-immune) is the whole reason this file exists in this shape:
// Answer is legal only for block <= deadline; Reclaim is legal only for
// block > deadline+ReclaimGrace. Those two half-open ranges are disjoint by
// construction whenever ReclaimGrace > 0 (true: ReclaimGrace = 1200), so for
// any single block at most one of the two can ever succeed — independent of
// which one a block producer chooses to place first. See
// TestAnswerReclaimWindowsDisjoint for the exhaustive proof.
//
// Rule 4 (API.md) — "the billing state must never gate funds" — means Answer
// and Reclaim call NEITHER Phase NOR RequireInflowOpen. Only Ask (a new
// inflow) is gated. This is deliberate, not an oversight: SPEC §1.7.5 is
// explicit that "a creator mid-answer when their subscription lapses still
// gets paid for finishing the work," and reclaim must work in every phase
// including FROZEN and CLOSED so nobody's refund is ever held hostage by an
// unpaid invoice (§1.7.2 guardrail #1).

// AskResult / AnswerResult — API.md's shapes, plus RateUsed (added by the
// 2026-07-20 fix below): Ask no longer takes a rate parameter, so the caller
// (the wasm wrapper's `ask`/`quote` entrypoints) needs this to know what was
// actually used, for event logging and for the response it returns.
type AskResult struct {
	Seq           uint64
	CreditsSpent  *big.Int
	CommissionHbd *big.Int
	RateUsed      *big.Int
}

// AnswerResult — CreditsToCreator plus CommissionHbd (added 2026-07-21, at
// the indexer agent's request): Answer books rec.commissionHbd to
// kTreasury() as the "delivered service" leg of I5, but until this field
// existed the caller had no way to learn what that booked amount actually
// was — the indexer's EvAnswered event couldn't reconstruct the
// answered->treasury HBD flow from the event stream alone, mirroring the
// identical gap ReclaimResult.CommissionHbd already closed on the reclaim
// side. The wasm wrapper reads this to populate EvAnswered's own
// commissionHbd argument; core itself still never moves HBD — Answer's own
// addMoney(kTreasury(), rec.commissionHbd) already IS the actual booking,
// this field is purely informational for the caller/event log.
type AnswerResult struct {
	CreditsToCreator *big.Int
	CommissionHbd    *big.Int
}

// ReclaimResult — the credits in full, plus the held commission MINUS the miss
// slice. I5 (SPEC §1.7.2 rule 4: "No commission on refunds...We are paid for
// delivered service only") held without exception until USER RULING 1
// (2026-07-28) carved one, because a 100% refund made griefing free; see
// MissReclaimSliceBps in params.go. Decline still refunds everything, and the
// credits are still returned whole on both paths.
// CommissionHbd is HBD, which core itself
// never moves — the wasm wrapper is responsible for actually paying it back
// via sdk.HiveTransfer (see contract/main.go's `reclaim` entrypoint), the
// same division of responsibility Refund's own HBD payout already has.
//
// Asker (added by the H1 defect fix, 2026-07-21: permissionless reclaim —
// see Reclaim's own doc) names WHO actually got paid, which is no longer
// guaranteed to be the caller. The wrapper must pay CreditsReturned/
// CommissionHbd's real-world HBD leg to THIS account, never to whoever
// happened to submit the transaction.
type ReclaimResult struct {
	CreditsReturned *big.Int
	CommissionHbd   *big.Int
	// CommissionRetainedHbd is the slice kept by the protocol because this
	// reclaim was a MISS (USER RULING 1, 2026-07-28 — see MissReclaimSliceBps).
	// It is already booked to kTreasury() by Reclaim itself; the wrapper must
	// NOT move it. It is reported only so the emitted event carries both halves
	// of the split and a replaying indexer can still account for every unit of
	// the commission that was held. Always zero on a self-dealt escrow, which
	// is not a miss. CommissionHbd above is the NET figure to pay the asker.
	CommissionRetainedHbd *big.Int
	Asker                 string
}

// Escrow status codes. Local to this file: keys.go owns only the key
// builder ("the key builder lives here so the schema stays in one file" —
// keys.go:41), the packed value format is this module's business.
const (
	askPending   = "PENDING"
	askAnswered  = "ANSWERED"
	askReclaimed = "RECLAIMED"
	// askDeclined — the creator turned this job down inside the answer window
	// and handed everything back (Decline, RULING E, 2026-07-27). Distinct
	// from RECLAIMED so the record shows WHO ended it: an asker taking their
	// money back after being ignored is a black mark on the creator, a creator
	// saying "I can't take this" promptly is not.
	askDeclined = "DECLINED"
)

// escrowRec is the unpacked form of one e|<creator>|<seq> record.
//
// commissionHbd (added by the 2026-07-20 defect fix) is the HBD commission
// leg HELD against this specific ask, not booked to the treasury until
// Answer succeeds. Before this field existed, Ask booked the commission to
// kTreasury() immediately on open, and Reclaim had nowhere to read it back
// from — an asker who was never answered permanently forfeited 12% of face,
// directly contradicting SPEC §1.7.2 rule 4 ("the asker gets 100% back") and
// this file's own I5 invariant. Holding it here, keyed to the escrow that
// earned it, is what makes both Answer's booking and Reclaim's refund exact
// and idempotent — see Ask/Answer/Reclaim below.
// acqBlock (the hold-clock half of the ET-2 fix, adversarial fix round 1,
// 2026-07-22) is the escrowed slice's OWN weighted-average acquisition block
// at the instant Ask took the tokens out of the holder's balance. It
// exists so an escrow that delivers NOTHING can be undone exactly: Reclaim
// puts the tokens back with the AGE they left with, instead of re-aging them
// to fresh. Before it, one unanswered ask re-aged the asker's clock, which
// charged "exit tax" to a fan who was selling into a market that had not
// moved — harm triggered by the counterparty's non-delivery.
//
// WHY RETURNING IT CANNOT LAUNDER ANYTHING, which is what ask.go's old
// "reset on ANY inflow, zero exceptions" comment got wrong: Reclaim can only
// ever credit rec.asker, with acqBlock stored at escrow-out time, so it is
// exactly conserved rather than created — the age-weight identity
// ((bal−c)·w + n·B + c·w) / (bal+n) == (bal·w + n·B) / (bal+n) makes an
// escrow round trip exactly age-NEUTRAL: the asker ends up with the same
// clock they would have had if they had never escrowed. Nothing can be
// inflated because nothing is chosen at reclaim time. Answer is different and
// stays different: the CREATOR is credited with a fresh clock (creditInflow),
// which is the conservative direction.
//
// RULING K (2026-07-22) removed the cost-basis half of the ET-2 fix along
// with kBasis: the exit tax is now gross proceeds × τ(h) with no realized-
// gain cap, so an escrow no longer needs to preserve a basis across a reclaim
// (there is no basis anywhere). Only the age clock is conserved.
type escrowRec struct {
	asker         string
	credits       *big.Int
	deadline      uint64
	status        string
	contentHash   string
	answerHash    string
	commissionHbd *big.Int
	acqBlock      uint64 // the asker's wacq at escrow-out (0 == unclocked)
	offeringID    uint64 // which named service this ask bought (0 == the legacy `face` price)
}

// Packed layout: asker|credits|deadline|status|commissionHbd|acqBlock|offeringID|contentHash|answerHash.
//
// asker/status/credits/deadline/commissionHbd/acqBlock/offeringID are all closed
// alphabets (validAccount, the 3 status consts, decimal digits) that
// structurally cannot contain "|". contentHash and answerHash are the only free-form
// fields — Ask and Answer both reject a "|" in them at the door (see
// below) — and they are kept LAST in this layout on purpose, exactly as
// before commissionHbd was added: SplitN's final element absorbs anything
// remaining, so even if a future caller ever failed to validate one of them,
// only answerHash (the true last field) could silently swallow a stray "|",
// never a money field. commissionHbd, acqBlock and offeringID are all inserted
// between status and contentHash rather than appended at the end so this
// ordering is preserved. This format round-trips exactly with no escaping needed —
// matching the rest of the codebase (errors.go, keys.go concatenate fields
// without escaping too).
//
// offeringID (2026-07-27) records WHICH named service the ask was opened
// against — 0 meaning the legacy single `face` price (offerings.go). It is
// recorded at Ask time and never re-read for money: the escrow's own `credits`
// and `commissionHbd` are what Answer and Reclaim settle, so deleting or
// repricing an offering afterwards cannot move a single base unit of an ask
// already in flight. It exists so the delivery record and the buyer's receipt
// can name the service that was bought.
//
// ★ THE FIELD COUNT IS LOAD-BEARING. This layout is positional and unpackEscrow
// demands an EXACT count, so adding a field is a breaking change to every
// reader — parser, fixtures, and the frontend payload contract must move in one
// commit. A 2026-07-24 audit caught the previous insertion (acqBlock) having
// been made without updating the parser, which silently shifted contentHash
// into answerHash on every read. That is why the count check below is exact.
func packEscrow(r escrowRec) string {
	return r.asker + "|" + r.credits.String() + "|" +
		strconv.FormatUint(r.deadline, 10) + "|" + r.status + "|" +
		r.commissionHbd.String() + "|" +
		strconv.FormatUint(r.acqBlock, 10) + "|" +
		strconv.FormatUint(r.offeringID, 10) + "|" +
		r.contentHash + "|" + r.answerHash
}

func unpackEscrow(v string) (escrowRec, bool) {
	p := strings.SplitN(v, "|", 9)
	if len(p) != 9 {
		return escrowRec{}, false
	}
	credits, ok := new(big.Int).SetString(p[1], 10)
	if !ok || credits.Sign() < 0 {
		return escrowRec{}, false
	}
	deadline, err := strconv.ParseUint(p[2], 10, 64)
	if err != nil {
		return escrowRec{}, false
	}
	commissionHbd, ok := new(big.Int).SetString(p[4], 10)
	if !ok || commissionHbd.Sign() < 0 {
		return escrowRec{}, false
	}
	acqBlock, err := strconv.ParseUint(p[5], 10, 64)
	if err != nil {
		return escrowRec{}, false
	}
	offeringID, err := strconv.ParseUint(p[6], 10, 64)
	if err != nil {
		return escrowRec{}, false
	}
	return escrowRec{
		asker: p[0], credits: credits, deadline: deadline,
		status: p[3], commissionHbd: commissionHbd,
		acqBlock:    acqBlock,
		offeringID:  offeringID,
		contentHash: p[7], answerHash: p[8],
	}, true
}

func loadEscrow(s Store, creator string, seq uint64) (escrowRec, bool) {
	v, ok := s.Get(kEscrow(creator, seq))
	if !ok || v == "" {
		return escrowRec{}, false
	}
	return unpackEscrow(v)
}

func saveEscrow(s Store, creator string, seq uint64, r escrowRec) {
	setStr(s, kEscrow(creator, seq), packEscrow(r))
}

// creditsForAsk = ceil(face/rate) (API.md Units: "Credits spent per ask =
// ceilDiv(face, rate); rounding favours the reserve"). rate is HBD base
// units PER CREDIT (SPEC §1.3b): a higher rate (token appreciated) means
// fewer credits change hands for the same HBD-denominated face price — the
// entire point of settling asks in tokens at the prevailing rate rather
// than at a fixed credit count. Caller guarantees rate > 0 (settleSpend
// derives it — RULING C keeps the ceil: a floor would admit 0 credits, a
// free service).
func creditsForAsk(face, rate *big.Int) *big.Int {
	return mMulDivCeil(face, big.NewInt(1), rate)
}

// commissionOwedFor = floor(face * CommissionBps / 10000) — the minimum HBD
// commission leg (SPEC §1.7.3) a payment against face must carry.
func commissionOwedFor(face *big.Int) *big.Int {
	return mMulBpsDiv(face, CommissionBps)
}

// splitFace divides a creator's POSTED price into the two legs a buyer pays:
// the token leg that reaches the creator, and the HBD commission leg that
// reaches the platform.
//
// USER RULING 2026-07-27 — THE PRICE ON THE SCREEN IS THE PRICE THE BUYER
// PAYS. A creator who posts "custom song — 200 HBD" means the buyer parts with
// 200 HBD of value in total; the platform's 12% is CARVED OUT of that, never
// added on top. This restores what SPEC §1.7.3 always specified ("the asker
// signs one transaction carrying both a transfer.allow intent for the 12% in
// HBD and the token spend for the creator's 88%"). The code had drifted to
// settling the token leg at the FULL posted face while ALSO drawing the 12%
// separately, so a posted "200" actually cost the buyer 224 — a surcharge that
// appeared in no quote, on no screen, and in no spec.
//
// THE TWO LEGS SUM TO EXACTLY THE POSTED FACE, always: commission is
// floor(face·CommissionBps/10000) and the token leg takes the REMAINDER, so
// the integer division can only ever round in the CREATOR's favour, by at most
// one base unit, and never against the buyer. This mirrors accrueExitTax's
// floor-then-remainder split (exittax.go) for the same reason: two independent
// roundings would create or destroy dust, one rounding plus a remainder
// cannot.
//
// Callers must never split a face themselves — settlement.go's settlePosted is
// the single door, so a quote can never disagree with the settlement it
// previews.
func splitFace(face *big.Int) (tokenLeg, commission *big.Int) {
	commission = commissionOwedFor(face)
	tokenLeg = new(big.Int).Sub(face, commission)
	return tokenLeg, commission
}

// SettlementRate MOVED to settlement.go and CHANGED SHAPE (RULING C,
// RULINGS-v2-2026-07-21): it now returns (rate, error) and REFUSES when no
// safe rate exists, instead of falling back to PAR.
//
// WHAT THE PREVIOUS VERSION HERE DID AND WHY IT WAS WRONG: it returned "the
// short TWAP when AskRate's guards pass, PAR (1 base unit per credit)
// otherwise", with no error path — an honest-sounding 2026-07-20 fix for
// "RecordObs is called from nothing, so asks revert forever". Both halves
// rotted: the trade path NOW feeds the rings (Buy/Sell call RecordObs — the
// curve is the price source), so the "no feed exists" premise is gone; and
// PAR was never safe — it is wrong by exactly the factor `spot`, always in
// the asker-robbing direction (a MinFace 0.1 HBD service against a token
// worth 100 base units cost 100 tokens at PAR where correct pricing costs
// 1 — a 100x overcharge), and the fallback fired on ordinary conditions (a
// market quiet 3 days, a >20% move). See settlement.go for the ruled
// replacement: rate = min(TWAP_short, TWAP_long, spot) + the depth/spend/
// min-price guards, all of it shared verbatim by Ask below.

// Ask opens an escrowed ask against creator: creditsForAsk(face, rate)
// credits move out of the caller's balance into a new escrow record, and a
// separate HBD commission leg is checked and HELD in that same record (not
// booked to the treasury yet — see the file-level comment and Answer/
// Reclaim below). The contract never holds a unit of the creator's token
// for its own account — only HBD passes through kTreasury (SPEC §1.7.3),
// and only once it is actually earned.
//
// commissionHbdPaid must EXACTLY equal commissionOwedFor(face) at the block
// this call executes (H2 defect fix, 2026-07-21 — see the guard below):
// this is a binding amount, not a cap and not a minimum.
//
// rate is NEVER a parameter here (removed 2026-07-20, see SettlementRate's
// doc): Ask derives its own settlement rate internally so SPEC §1.3b's
// manipulation defense cannot be silently bypassed by a caller — present or
// future — who forgets to pass the TWAP correctly. maxCredits (added the
// same day, an exploiter-scrutinizer finding) is the asker's own signed cap
// on how many credits this ask may cost, mirroring what transfer.allow
// already is for the commission's HBD leg — see the guard below for why it
// is needed even though rate itself is now tamper-resistant.
func Ask(s Store, caller, creator string, block uint64, maxCredits *big.Int, commissionHbdPaid *big.Int, contentHash string, deadlineBlocks uint64, offeringID uint64) (*AskResult, error) {
	if !validAccount(caller) {
		return nil, newErr(ErrInput, "invalid caller")
	}
	if !validAccount(creator) {
		return nil, newErr(ErrInput, "invalid creator")
	}
	if contentHash == "" {
		return nil, newErr(ErrInput, "empty content hash")
	}
	if len(contentHash) > MaxHashLen {
		return nil, newErr(ErrInput, "contentHash too long")
	}
	if strings.Contains(contentHash, "|") {
		return nil, newErr(ErrInput, "contentHash must not contain '|'")
	}
	if maxCredits == nil || !mGt(maxCredits, mZero()) {
		// Reject a zero/absent cap rather than defaulting to unlimited: an
		// absent maxCredits is exactly the bug this parameter exists to
		// close (see the guard below).
		return nil, newErr(ErrInput, "maxCredits must be > 0")
	}
	if commissionHbdPaid == nil || commissionHbdPaid.Sign() < 0 {
		return nil, newErr(ErrInput, "invalid commission amount")
	}
	if deadlineBlocks < MinAskDeadline || deadlineBlocks > MaxAskDeadline {
		return nil, newErr(ErrInput, "deadline out of band")
	}

	// New asks are an inflow: gated on ACTIVE/OVERDUE. This is the ONLY phase
	// check in this file — Answer and Reclaim deliberately have none (see the
	// file-level comment / rule 4).
	if err := RequireInflowOpen(s, creator, block); err != nil {
		return nil, err
	}

	// WHICH PRICE THIS ASK SETTLES AT (2026-07-27). offeringID 0 is the legacy
	// single `face` price and reads exactly the key it always did — the audited
	// path is untouched. A nonzero id names one of the creator's posted services
	// (offerings.go) and settles at THAT service's own banded price. Everything
	// downstream — settleSpend, maxCredits, the commission leg, the escrow — is
	// identical either way, because from here on there is only "the HBD price
	// this ask is denominated in".
	//
	// The lookup is LIVE, at execution, for the same reason the face read was:
	// the slippage caps below (maxCredits on the token leg, the exact-match
	// commission on the HBD leg) are what bound a price that moved between the
	// asker signing and this call executing. A deleted offering reads 0 and is
	// refused here, so a withdrawn service can never be bought.
	var face *big.Int
	if offeringID == 0 {
		face = getMoney(s, kFace(creator))
		if !mGt(face, mZero()) {
			return nil, newErr(ErrState, "creator has no face price set")
		}
	} else {
		face = OfferingPrice(s, creator, offeringID)
		if !mGt(face, mZero()) {
			return nil, newErr(ErrNotFound, "no such offering")
		}
	}

	// Settlement derivation + RULING C guards (settlement.go): the rate is
	// min(TWAP_short, TWAP_long, spot) and the spend clears the min-price,
	// depth-ceiling and spend-cap guards — or this call REFUSES with a typed
	// error (RULING C: refusing beats settling wrong; this is a new-service
	// INFLOW, already behind RequireInflowOpen above, so a refusal can never
	// gate funds). THE PREVIOUS VERSION settled at PAR whenever the TWAP was
	// unavailable, which overcharged the asker by exactly the factor `spot`
	// on a live code path — see settlement.go's autopsy.
	q, err := settlePosted(s, creator, block, face)
	if err != nil {
		return nil, err
	}
	rate := q.Rate
	creditsSpent := q.Credits

	// Slippage guard against a creator-controlled face spike — an exploiter
	// scrutinizer finding, 2026-07-20. `face` is read LIVE, above, straight
	// from state, and is entirely creator-controlled via SetFace; none of
	// SPEC §1.3b's four manipulation mitigations protect it — they all
	// protect `rate`, the oracle leg (twap.go). Intra-block transaction
	// order is producer-chosen, not consensus-enforced (verified at
	// source — see twap.go's file doc for the exact go-vsc-node lines), so
	// a creator can sandwich a victim's already-signed ask between two
	// SetFace calls in the same block: spike face, let the ask execute at
	// the inflated price, restore it after. The asker's only prior consent
	// was commissionHbdPaid, which bounds a DIFFERENT leg (the HBD
	// commission) and does nothing to cap the credits leg. maxCredits is
	// the missing cap, checked BEFORE any balance is touched so a spiked
	// face reverts this call cleanly instead of silently overspending —
	// exactly the role transfer.allow already plays for every other
	// inflow's HBD leg in this codebase.
	if mGt(creditsSpent, maxCredits) {
		return nil, newErr(ErrInput, "creditsSpent exceeds maxCredits")
	}

	// Commission is a separate HBD leg (SPEC §1.7.3): the asker's signed
	// transfer.allow intent is what actually moves this HBD (wasm layer's
	// job); this just gates the ask on the amount already proven paid.
	//
	// H2 DEFECT FIX (2026-07-21): this used to be a lower bound
	// (commissionHbdPaid >= owed), which HELD whatever was actually paid —
	// so a band-legal SetFace drop between the asker signing their quote and
	// this call executing (intra-block order is producer-chosen, not
	// consensus-enforced; see the maxCredits guard's identical ordering
	// argument above) meant the asker overpaid the commission on the OLD,
	// higher face, and the surplus got held here and then booked to the
	// treasury in full on Answer — up to 4x the true commission, with no
	// path back (C2: the treasury had no exit either). The fix makes this an
	// EXACT match: only the amount actually owed on the face in effect AT
	// THIS CALL may ever be held. The wrapper is responsible for drawing
	// only that amount (bounded by the asker's own signed transfer.allow
	// cap) — this is the credit leg's maxCredits cap, mirrored onto the HBD
	// leg.
	// The owed amount comes off the SAME quote the credits came from
	// (settlePosted, settlement.go) rather than being recomputed from `face`
	// here: the two legs must always be the two halves of one split, so that a
	// future change to the commission model cannot move one leg and leave the
	// other reading a stale face.
	if commissionHbdPaid.Cmp(q.CommissionHbd) != 0 {
		return nil, newErr(ErrBalance, "commission must exactly equal commissionOwedFor(face) at execution (not more, not less)")
	}

	// BOTH BUCKETS (2026-07-30). An asker whose position has wholly matured
	// holds no maturing key at all; reading kBal alone would refuse them their
	// own tokens and lock them out of the product's core loop — buy a creator's
	// token, spend it on that creator's services — precisely once they had held
	// long enough to be a committed customer.
	bal := totalBalance(s, creator, caller)
	if mLt(bal, creditsSpent) {
		return nil, newErr(ErrBalance, "insufficient credits")
	}
	// Chokepoint debit (holdclock.go): escrowed tokens leave the balance.
	// ET-2 FIX (2026-07-22, hold-clock half kept by RULING K): the asker's
	// hold clock is RECORDED in the escrow, not dropped. The old behaviour
	// returned a reclaimed escrow with a re-averaged clock, which meant a
	// creator who simply never answered re-aged the asker's position —
	// charging "exit tax" for the counterparty's non-delivery. See escrowRec's
	// doc for why returning it cannot launder anything (the clock is conserved,
	// never chosen, and can only ever be paid to rec.asker). RULING K deleted
	// the cost-basis half — the tax no longer caps at realized gain, so there
	// is no basis to record. The asker's own remaining position keeps its clock
	// either way — escrow-out never re-ages a remainder.
	// The recorded clock now spans both buckets — see escrowAcqBlock. A draw
	// taken wholly from matured tokens records one full window, so reclaiming or
	// declining returns them still matured rather than silently re-starting
	// their clock (which would be the same confiscation the ET-2 fix closed,
	// arriving through a new door).
	escFromMatured, escFromMaturing := splitDraw(s, creator, caller, creditsSpent)
	acqAtEscrow := escrowAcqBlock(s, creator, caller, block, escFromMatured, escFromMaturing)
	if err := debitPosition(s, creator, caller, creditsSpent); err != nil {
		return nil, err // unreachable given the check above; defense-in-depth
	}

	seq := getU64(s, kSeq(creator))
	// MaxAskDeadline (30d in blocks) is tiny next to a uint64 block height's
	// realistic range, so block+deadlineBlocks cannot overflow in practice —
	// same bounded-sum argument as HIVE-PRICE-MARKET/market/settle.go:52.
	deadline := block + deadlineBlocks
	saveEscrow(s, creator, seq, escrowRec{
		asker: caller, credits: creditsSpent, deadline: deadline,
		status: askPending, contentHash: contentHash, answerHash: "",
		commissionHbd: commissionHbdPaid,
		acqBlock:      acqAtEscrow,
		offeringID:    offeringID,
	})
	setU64(s, kSeq(creator), seq+1)

	// DEFECT FIX (2026-07-20): the commission is HELD here, in the escrow
	// record, NOT booked to kTreasury() yet. SPEC §1.7.2 rule 4 is verbatim:
	// "No commission on refunds. When an ask is reclaimed unanswered, the
	// asker gets 100% back. We are paid for delivered service only." Booking
	// it here, before the creator has done anything, contradicted that rule
	// and this file's own I5 invariant — Answer (below) books it on
	// delivery; Reclaim (below) returns it in full.

	return &AskResult{Seq: seq, CreditsSpent: creditsSpent, CommissionHbd: commissionHbdPaid, RateUsed: rate}, nil
}

// Answer pays the creator and resolves the escrow. Creator-only; escrow
// must be PENDING; legal ONLY while block <= deadline — the answer half of
// the I6 disjoint window. Deliberately consults NO phase/subscription
// state: legal in every phase including FROZEN (SPEC §1.7.5, API.md rule 4).
//
// Books the HBD commission held in the escrow (Ask, above) to kTreasury()
// HERE, on delivery — never earlier. This is the "delivered service" half
// of SPEC §1.7.2 rule 4: the platform earns its 12% only once the creator
// has actually answered, proven by this call succeeding, not by the ask
// merely having been opened. Runs exactly once per escrow: Answer requires
// status == PENDING and immediately flips it to ANSWERED before returning,
// so a second call on the same seq is rejected before it ever reaches this
// line — see TestAnswerBooksCommissionExactlyOnce.
func Answer(s Store, caller, creator string, block, seq uint64, answerHash string) (*AnswerResult, error) {
	if caller != creator {
		return nil, newErr(ErrAuth, "creator only")
	}
	if answerHash == "" {
		return nil, newErr(ErrInput, "empty answer hash")
	}
	if len(answerHash) > MaxHashLen {
		return nil, newErr(ErrInput, "answerHash too long")
	}
	if strings.Contains(answerHash, "|") {
		return nil, newErr(ErrInput, "answerHash must not contain '|'")
	}

	rec, ok := loadEscrow(s, creator, seq)
	if !ok {
		return nil, newErr(ErrNotFound, "no such escrow")
	}
	if rec.status != askPending {
		return nil, newErr(ErrState, "escrow not pending")
	}
	if block > rec.deadline {
		return nil, newErr(ErrState, "answer window closed")
	}

	// Chokepoint credit (holdclock.go): the escrowed tokens reach the creator
	// carrying the MATURITY THEY ALREADY HAD — rec.acqBlock, the asker's own
	// clock recorded at escrow-out — re-averaged into whatever the creator
	// already holds. Infallible (RULING G). RULING K deleted the cost basis,
	// so the credit carries only the balance and the clock.
	//
	// THIS REVERSES THE OLD RULE ("wacq resets on ANY inflow, so service-earned
	// tokens are exit-taxed as fresh"), and the reversal is TOKEN MATURITY
	// (USER-RULED 2026-07-27) applied consistently. The old rule made delivery a
	// maturity INCINERATOR: a buyer who had held for six weeks and spent those
	// tokens on a service destroyed the maturity in the act of paying — the
	// exact confiscation the transfer fix just removed, wearing a different hat.
	// It also left conservation an INEQUALITY (maturity could be burned but
	// never minted), and an inequality is the shape a future leak hides inside;
	// carrying the clock makes it an equality that can be asserted.
	//
	// It grants no new capability: the asker could always have moved the same
	// tokens with the same clock via TransferCredits, so nothing is reachable
	// here that was not reachable before. And it is symmetric with the two rails
	// that already carry rec.acqBlock — Reclaim and Decline both return the
	// escrow age-neutral, so an escrow that is ANSWERED must not be the one path
	// that destroys age.
	creditInflowAt(s, creator, creator, rec.credits, rec.acqBlock, block)
	addMoney(s, kTreasury(), rec.commissionHbd)
	rec.status = askAnswered
	rec.answerHash = answerHash
	saveEscrow(s, creator, seq, rec)
	recordDelivery(s, creator, rec.asker) // delivery gate (delivery.go) — counters only

	return &AnswerResult{CreditsToCreator: rec.credits, CommissionHbd: rec.commissionHbd}, nil
}

// Reclaim returns the asker's credits AND the held commission in full — no
// commission is EVER charged on a reclaim (I5, SPEC §1.7.2 rule 4: "the
// asker gets 100% back. We are paid for delivered service only"). Escrow
// must be PENDING; legal ONLY while block > deadline+ReclaimGrace — the
// reclaim half of the I6 disjoint window. Deliberately consults NO phase/
// subscription state: legal in every phase including FROZEN and CLOSED
// (SPEC §1.7.2 guardrail #1: non-payment must never touch funds).
//
// H1 DEFECT FIX (2026-07-21): PERMISSIONLESS once the reclaim window is
// open — no longer asker-only. `caller` plays NO role in any key this
// function reads or writes and can never be paid; the payout ALWAYS lands
// on `rec.asker` (see ReclaimResult.Asker), the exact same "anyone may push,
// only the rightful owner is ever paid" shape refund.go's RefundHolder
// already established for the wind-down push. Before this fix, Ask debited
// kBal but never kSupply, so a PENDING escrow permanently pinned
// supply > 0; CloseIfDrained requires supply==0 to fire, and Register's own
// duplicate-registration guard refuses a market that is not CLOSED — so an
// asker who simply never came back to reclaim their own abandoned escrow
// bricked the creator's identity-bound market FOREVER, with no path for
// ANYONE (not the creator, not a keeper, not the asker's own heirs) to ever
// unstick it. Making the push permissionless closes that: once the window
// opens, a keeper, the creator, or any third party can resolve an abandoned
// escrow, supply drains, and CloseIfDrained/Register work again — while the
// money itself is exactly as safe as it always was, since it can only ever
// land on the asker who is actually owed it.
//
// caller is checked for non-emptiness only (an authenticated-but-arbitrary
// trigger), mirroring RefundHolder's identical treatment of its own
// `caller` parameter for the identical reason.
//
// DEFECT FIX (2026-07-20): the commission was previously booked to
// kTreasury() the instant Ask opened, and this function had no field to
// read it back from — an unanswered ask permanently cost the asker 12% of
// face, contradicting SPEC §1.7.2 rule 4 verbatim. Now the commission is
// only ever HELD in the escrow record (Ask) and only ever BOOKED on Answer,
// so Reclaim has nothing to reverse in the treasury — it hands the held
// amount back net of the miss slice it books to the treasury itself
// (MissReclaimSliceBps), exactly once (status flips to RECLAIMED before
// returning, so a second call is rejected before reaching here). core
// itself never moves HBD: the caller (contract/main.go's `reclaim`
// entrypoint) is responsible for actually paying CommissionHbd back via
// sdk.HiveTransfer TO ReclaimResult.Asker (never to whoever submitted the
// transaction), mutating state first (this call) and transferring second —
// CEI ordering, the same pattern `refund`/`refundHolder` already use for
// their own HBD payouts.
func Reclaim(s Store, caller, creator string, block, seq uint64) (*ReclaimResult, error) {
	if caller == "" {
		return nil, newErr(ErrAuth, "empty caller")
	}
	rec, ok := loadEscrow(s, creator, seq)
	if !ok {
		return nil, newErr(ErrNotFound, "no such escrow")
	}
	if rec.status != askPending {
		return nil, newErr(ErrState, "escrow not pending")
	}
	if block <= rec.deadline+ReclaimGrace {
		return nil, newErr(ErrState, "reclaim window not open")
	}

	// Chokepoint credit (holdclock.go). ET-2 FIX (2026-07-22, hold-clock half
	// kept by RULING K): the tokens go back to the asker with EXACTLY the
	// acquisition clock they left with — a nothing-happened escrow is restored
	// to nothing-happened. rec.acqBlock was written by Ask from the
	// asker's own state at escrow-out and can only ever be paid to rec.asker,
	// so it is conserved rather than created; the age-weight identity in
	// escrowRec's doc shows the round trip is exactly age-neutral, i.e. the
	// asker cannot end up older than if they had never escrowed. THE OLD
	// COMMENT HERE CLAIMED "the rule is reset on ANY inflow with zero
	// exceptions, because every exception is a laundering channel" — that is
	// FALSE for a same-account return of an age recorded at exit, and enforcing
	// it charged the asker for the creator's non-delivery. A legacy record with
	// acqBlock 0 degrades to `block` inside creditInflowAt — i.e. the
	// seller-adverse direction. RULING K deleted the cost basis, so nothing but
	// the clock is restored.
	creditInflowAt(s, creator, rec.asker, rec.credits, rec.acqBlock, block)
	rec.status = askReclaimed
	saveEscrow(s, creator, seq, rec)
	// Delivery gate (delivery.go): reaching this line IS the definition of a
	// miss — the window guard above proves this escrow sat PENDING past
	// deadline+ReclaimGrace. recordMiss is infallible and returns nothing, so
	// it can never make this outflow revert (RULING G); the asker's money is
	// already back above regardless of what it decides about the creator.
	//
	// A SELF-DEALT escrow is not a miss (recordMiss returns immediately on
	// asker==creator), and the same condition governs the commission slice
	// below, so the two can never disagree about whether this was an offence.
	offence := rec.deadline + ReclaimGrace
	recordMiss(s, creator, rec.asker, offence)

	// USER RULING 1 (2026-07-28), the ONLY exception to I5's "no commission on
	// refunds": on a miss the protocol keeps MissReclaimSliceBps of the HELD
	// commission so that manufacturing a miss is not free (params.go carries
	// the full reasoning, including why the cost lands on the asker and why the
	// slice can never go to the creator). The CREDITS are untouched — they went
	// back whole, above, before this line runs.
	//
	// Booked to kTreasury() here rather than by the wrapper because core owns
	// every HBD balance the contract holds; the wrapper only ever moves the NET
	// figure this returns, so the two cannot drift.
	returned := rec.commissionHbd
	retained := big.NewInt(0)
	if rec.asker != creator && returned != nil && returned.Sign() > 0 {
		retained = mMulDivCeil(returned, new(big.Int).SetUint64(MissReclaimSliceBps), big.NewInt(10000))
		returned = new(big.Int).Sub(returned, retained)
		addMoney(s, kTreasury(), retained)
	}

	return &ReclaimResult{
		CreditsReturned:       rec.credits,
		CommissionHbd:         returned,
		CommissionRetainedHbd: retained,
		Asker:                 rec.asker,
	}, nil
}

// Decline is the creator's free, honest "no": it returns the asker's credits
// AND the full commission inside the SAME window an Answer would be legal in,
// and it is explicitly NOT a miss (RULING E, 2026-07-27).
//
// WHY THIS EXISTS AT ALL. Without it the delivery gate would punish the wrong
// thing. A creator who is asked for something they cannot do — out of scope,
// out of time, a job they simply do not want — would have exactly two options:
// answer badly, or ignore it and take a miss. Decline makes saying no cost
// nothing, which is what lets the miss counter mean "you ignored a paying
// customer" rather than "you are selective". It is also what makes griefing
// pointless: a hostile asker who floods a creator with junk asks to
// manufacture misses can be cleared out for free, and pays a real commission
// and a real wait for the privilege of trying.
//
// NO COMMISSION IS KEPT, deliberately, on the same principle as Reclaim (I5,
// SPEC §1.7.2 rule 4 — "we are paid for delivered service only"): nothing was
// delivered here, so the platform takes nothing. A commission retained on
// decline would be a fee for saying no, and would quietly re-create the
// incentive to ignore asks instead.
//
// IT IS NEUTRAL IN THE GATE — NEITHER A DELIVERY NOR A MISS (see the full
// reasoning inline below, at the point the code actually enforces it). An
// earlier version of this doc said "it counts as a DELIVERY, not a neutral
// event," which was true of an earlier version of the CODE and stopped being
// true when a 2026-07-27 code review found that reasoning only holds if the
// decline is prompt — which nothing here measures (see the inline comment
// right after saveEscrow for the actual argument). Stated here again, plainly,
// because this is the doc comment the next reader sees first: Decline never
// calls recordDelivery or recordMiss.
//
// The wasm wrapper pays CommissionHbd back to Result.Asker (never to whoever
// submitted the transaction), state first and transfer second — the same CEI
// ordering `reclaim` already uses.
func Decline(s Store, caller, creator string, block, seq uint64) (*ReclaimResult, error) {
	if caller != creator {
		return nil, newErr(ErrAuth, "creator only")
	}
	rec, ok := loadEscrow(s, creator, seq)
	if !ok {
		return nil, newErr(ErrNotFound, "no such escrow")
	}
	if rec.status != askPending {
		return nil, newErr(ErrState, "escrow not pending")
	}
	// The ANSWER window, exactly — a creator may not decline a job whose
	// window has already closed. Past the deadline the escrow belongs to the
	// reclaim rail and the miss is already earned; letting a creator decline
	// there would be a retroactive eraser for a customer they had already
	// ignored, which is the one thing this whole gate is built to prevent.
	if block > rec.deadline {
		return nil, newErr(ErrState, "answer window closed")
	}

	// Same age-neutral restoration Reclaim performs: the asker gets their
	// tokens back carrying exactly the acquisition clock they left with, so a
	// nothing-happened escrow is restored to nothing-happened and the creator's
	// refusal cannot re-age (and therefore cannot exit-tax) the asker.
	creditInflowAt(s, creator, rec.asker, rec.credits, rec.acqBlock, block)
	rec.status = askDeclined
	saveEscrow(s, creator, seq, rec)
	// A DECLINE IS NEUTRAL IN THE GATE: it is neither a delivery nor a miss.
	// It used to count as a DELIVERY, on the reasoning that promptly clearing
	// your inbox is running your shop properly — but a code review (2026-07-27)
	// showed that reasoning only holds if the decline IS prompt, and this call
	// carries nothing that measures promptness. The escrow records its deadline
	// and the asker's token age, never the block the ask was opened at, so
	// "declined quickly" and "declined at the last legal block, after the
	// customer waited the entire window for nothing" are indistinguishable
	// here. Counting the second as delivery let maximal stalling produce a
	// perfect record.
	//
	// Neutral is the honest reading and it keeps every property the gate needs:
	//   - declining is still FREE for the creator — it can never earn a miss,
	//     which is what makes saying no cost nothing;
	//   - the anti-grief rail still works — junk asks aimed at manufacturing
	//     misses are cleared away and simply leave no trace in the ratio;
	//   - and it can no longer pad the denominator, so it cannot dilute real
	//     misses (the same hole the self-deal filter closes from the other
	//     side).
	// Declines are still counted and shown SEPARATELY by the indexer, which is
	// the right home for "this creator declines everything": that is a
	// reputation signal for a buyer to weigh, not a solvency question for the
	// contract to enforce.

	return &ReclaimResult{CreditsReturned: rec.credits, CommissionHbd: rec.commissionHbd, Asker: rec.asker}, nil
}
