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
// before the deadline (the creator's 88% releases to them and the platform's
// 12% releases to the owner account — delivered service) or, past
// deadline+ReclaimGrace, Reclaim pays the credits back to the asker (SPEC
// §1.7.2 rule 4 / I5 — see Reclaim's own doc, and MissReclaimSliceBps for the
// one ruled slice a MISS keeps).
//
// ★ THERE IS NO HBD ANYWHERE ON THIS RAIL ANY MORE (OWNER RULING 2026-09-12).
// The 12% commission used to be a SECOND leg the buyer paid in HBD, drawn by
// the wrapper with sdk.HiveDraw and held in the escrow record until Answer
// booked it to kTreasury(). A customer therefore needed two assets to buy a
// service with the token they already held, which defeated the product's own
// core loop. The commission is now 12% OF THE TOKENS: the buyer is debited the
// whole posted price in credits, the escrow holds all of it, and on delivery
// 12% is credited to the platform owner's position on that same market. The
// owner sells it on the curve like any other holder, paying the ordinary trade
// fee and exit tax — the contract itself never sells anything. Reclaim is PERMISSIONLESS once that window opens (H1 defect fix,
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
	Seq          uint64
	CreditsSpent *big.Int
	// CommissionCredits is the platform's slice OF CreditsSpent, held inside the
	// same escrow until it settles. It is not a second payment and not a second
	// asset — CreditsSpent is the whole of what left the buyer.
	CommissionCredits *big.Int
	RateUsed          *big.Int
}

// AnswerResult — what each party actually received. CreditsToCreator and
// CommissionToOwner are the two halves of the escrow's credits and always sum
// to exactly it, so an indexer can reconstruct the whole settlement from the
// EvAnswered event alone (that is why the second field exists at all — added
// 2026-07-21 at the indexer agent's request, when it was still an HBD figure).
//
// CommissionToOwner is what was ACTUALLY credited, not what was owed: it is
// zero when no owner is bound (Owner(s) == "", pre-Init state), in which case
// the whole escrow goes to the creator. Reporting the owed figure there would
// let an indexer book tokens to an account that never received any.
type AnswerResult struct {
	CreditsToCreator  *big.Int
	CommissionToOwner *big.Int
	// OwnerGraduated is how much of the OWNER's own previously-maturing position
	// on this market crossed into the MATURED bucket when this answer banked it
	// before the commission credit landed (F-C1/F-C8), for the same reason
	// ReclaimResult.Graduated exists: the wrapper cannot measure a delta on an
	// account that is neither its caller nor its creator. Zero when nothing aged
	// out, which is the ordinary case.
	OwnerGraduated *big.Int
	// Owner is WHO the commission was credited to, or "" when none was bound.
	// The wrapper needs it to emit the mint against the right account.
	Owner string
}

// ReclaimResult — the credits returned to the asker, and (on a MISS) the slice
// kept. I5 (SPEC §1.7.2 rule 4: "No commission on refunds...We are paid for
// delivered service only") held without exception until USER RULING 1
// (2026-07-28) carved one, because a 100% refund made griefing free; see
// MissReclaimSliceBps in params.go. Decline still refunds everything.
//
// ★ BOTH FIGURES ARE TOKENS NOW (OWNER RULING 2026-09-12). The miss slice used
// to be taken out of a separate HBD commission leg, leaving the CREDITS whole
// on every path; there is no HBD leg left, so the slice is taken out of the
// commission portion of the credits themselves. CreditsReturned is therefore
// the NET figure — what the asker actually gets back — and core has already
// moved both halves internally. The wrapper moves NOTHING on this path any
// more: no HiveTransfer, no HiveDraw.
//
// Asker (added by the H1 defect fix, 2026-07-21: permissionless reclaim —
// see Reclaim's own doc) names WHO actually got paid, which is no longer
// guaranteed to be the caller. It is the account core credited; the wrapper
// must emit against THIS account, never whoever happened to submit the
// transaction.
type ReclaimResult struct {
	CreditsReturned *big.Int
	// CommissionRetainedCredits is the slice kept by the protocol because this
	// reclaim was a MISS (USER RULING 1, 2026-07-28 — see MissReclaimSliceBps).
	// Reclaim itself has already credited it to the platform owner's position on
	// this market; the wrapper must NOT move it. It is reported so the emitted
	// event carries both halves of the split and a replaying indexer can account
	// for every unit. Always zero on a self-dealt escrow (not a miss), on a
	// Decline, and when no owner is bound.
	CommissionRetainedCredits *big.Int
	// Owner is who that slice was credited to, or "" when none was bound or
	// nothing was retained. OwnerGraduated is that account's own graduation
	// delta, for the same reason AnswerResult.OwnerGraduated exists.
	Owner          string
	OwnerGraduated *big.Int
	Asker          string
	// Graduated is how much of the asker's OWN previously-maturing position
	// crossed into the MATURED bucket when this reclaim/decline banked it before
	// re-crediting (F-C1/F-C8). The wrapper needs it to emit the matured-mint
	// event, because the recipient here is the asker — which the wrapper does not
	// know until this result carries it back (Decline's caller is the CREATOR, not
	// the asker, so it cannot measure the delta itself). Zero when nothing aged out.
	Graduated *big.Int
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
// commissionCredits (added by the 2026-07-20 defect fix, re-denominated from
// HBD to tokens by the OWNER RULING 2026-09-12) is the platform's slice OF
// `credits` — a partition of the escrow, not an extra charge on top of it —
// HELD against this specific ask and paid to nobody until it settles. Before
// this field existed, Ask booked the commission immediately on open and Reclaim
// had nowhere to read it back from, so an asker who was never answered
// permanently forfeited 12% of face, directly contradicting SPEC §1.7.2 rule 4
// ("the asker gets 100% back") and this file's own I5 invariant. Recording it
// here, keyed to the escrow that earned it, is what makes Answer's payout and
// Reclaim's refund exact and idempotent — see Ask/Answer/Reclaim below.
//
// IT IS RECORDED, NOT RECOMPUTED, at settlement time. Recomputing 12% of
// `credits` on the Answer path would give the same number today, but the escrow
// is the receipt for a price agreed at ASK time and a future commission ruling
// must not be able to reach backwards into an ask already in flight — the same
// argument offeringID's doc below makes about repricing an offering.
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
	commissionCredits *big.Int
	acqBlock          uint64 // the asker's wacq at escrow-out (0 == unclocked)
	offeringID    uint64 // which named service this ask bought (0 == the legacy `face` price)
}

// Packed layout: asker|credits|deadline|status|commissionCredits|acqBlock|offeringID|contentHash|answerHash.
//
// ★ THE LAYOUT AND THE FIELD COUNT ARE UNCHANGED across the 2026-09-12
// commission ruling, deliberately. Field 5 changed UNIT (HBD base units ->
// credits) but not position, type or validation (a non-negative decimal
// integer), so every reader — parser, fixtures, indexer — keeps working byte
// for byte and the migration carries no re-encoding step. No PENDING escrow has
// ever existed on mainnet, so no in-flight record is being reinterpreted; if one
// ever had, the unit change would have had to be a field ADDITION instead.
//
// asker/status/credits/deadline/commissionCredits/acqBlock/offeringID are all closed
// alphabets (validAccount, the 3 status consts, decimal digits) that
// structurally cannot contain "|". contentHash and answerHash are the only free-form
// fields — Ask and Answer both reject a "|" in them at the door (see
// below) — and they are kept LAST in this layout on purpose, exactly as
// before commissionHbd was added: SplitN's final element absorbs anything
// remaining, so even if a future caller ever failed to validate one of them,
// only answerHash (the true last field) could silently swallow a stray "|",
// never a money field. commissionCredits, acqBlock and offeringID are all inserted
// between status and contentHash rather than appended at the end so this
// ordering is preserved. This format round-trips exactly with no escaping needed —
// matching the rest of the codebase (errors.go, keys.go concatenate fields
// without escaping too).
//
// offeringID (2026-07-27) records WHICH named service the ask was opened
// against — 0 meaning the legacy single `face` price (offerings.go). It is
// recorded at Ask time and never re-read for money: the escrow's own `credits`
// and `commissionCredits` are what Answer and Reclaim settle, so deleting or
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
		r.commissionCredits.String() + "|" +
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
	commissionCredits, ok := new(big.Int).SetString(p[4], 10)
	if !ok || commissionCredits.Sign() < 0 {
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
		status: p[3], commissionCredits: commissionCredits,
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

// validEventHash rejects the control bytes that would make an emitted event's
// JSON invalid.
//
// DEFECT FIX 2026-08-19 (PRUNED finding F8), and the second time this exact
// class has been closed here. contentHash and answerHash are the only two
// free-form strings this contract puts into an event payload, and they were
// validated for emptiness, length and '|' alone. A single control byte in
// either makes the emitted EvAsked/EvAnswered JSON invalid, and the indexer
// drops an event it cannot unmarshal (magi-mongo-indexer mapper.go:87-105:
// a failed json.Unmarshal returns no mapping, and every caller gates the
// structured insert on a non-nil mapping). Two consequences were measured:
// five self-cycles left on-chain delta 0 and an indexer fold of +5, because the
// `asked` debit is poisonable while the `reclaimed` credit is not; and one
// newline in answerHash kills the only event carrying creditsToCreator, which
// is the wind-down keeper's own holder-discovery source, so the automated
// keeper never issues refundHolder for that creator and the market cannot
// drain through it.
//
// ★ THE SIBLING WAS ALREADY FIXED AND THESE TWO WERE MISSED. offerings.go's
// validOfferTitle has carried exactly this loop since 2026-07-28. A fix landed
// on one member of a class is a map to the members that were never swept — the
// whole 16-site emit surface was re-swept this time, and these were the only
// two left open.
//
// Byte-wise, not rune-wise, for validOfferTitle's reason: MaxHashLen bounds the
// byte length, and every UTF-8 continuation byte is >= 0x80, so this can never
// mistake a legitimate multi-byte code point for a control byte.
func validEventHash(field, v string) error {
	for i := 0; i < len(v); i++ {
		if c := v[i]; c < 0x20 || c == 0x7f {
			return newErr(ErrInput, field+" must not contain a control character")
		}
	}
	return nil
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

// commissionOwedFor = floor(n * CommissionBps / 10000) — the platform's slice
// of a settled payment (SPEC §1.7.3).
//
// `n` is a CREDIT COUNT since the OWNER RULING 2026-09-12; it was an HBD face
// before. The formula is identical, which is exactly why the unit has to be
// stated: the only caller is settlement.go's settlePosted, which applies it to
// the credits a posted face settled at, and the creator takes the REMAINDER so
// the floor can only ever round in the creator's favour.
func commissionOwedFor(n *big.Int) *big.Int {
	return mMulBpsDiv(n, CommissionBps)
}

// THERE IS NO splitFace. It divided a creator's POSTED price into a token leg
// (88%, priced through settleSpend) and an HBD commission leg (12%, drawn from
// the buyer by the wrapper) — USER RULING 2026-07-27, "the price on the screen
// is the price the buyer pays", which was and remains correct.
//
// The OWNER RULING of 2026-09-12 keeps that guarantee and drops the second
// currency: the whole posted price is priced in tokens and the commission is
// carved out of the resulting CREDITS instead (settlement.go's settlePosted).
// So the split moved one step downstream, from face-into-two-faces to
// credits-into-two-credits, and there is no longer anything here to split. The
// two inverse searches that grossed the C4/C2 bounds back up through this
// function (minPostedForTokenLeg / maxPostedForTokenLeg) went with it, and
// MinFace lost its 577 gross-up and is the plain C4 floor again (params.go).

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
// credits — the WHOLE posted price — move out of the caller's balance into a
// new escrow record, and the platform's 12% slice of them is recorded in that
// same record, paid to nobody until the escrow settles (see the file-level
// comment and Answer/Reclaim below).
//
// ★ THERE IS NO commissionHbdPaid PARAMETER ANY MORE (OWNER RULING
// 2026-09-12). It used to be a binding amount the wrapper had already drawn
// from the buyer in HBD, which this function re-derived and required to match
// EXACTLY (H2 defect fix, 2026-07-21) so a face change between signing and
// execution could not be used to overcharge the HBD leg. With the commission
// carved out of the tokens there is only ONE leg and only one cap left to
// enforce: maxCredits, the asker's own signed ceiling on the total, which
// bounds the commission implicitly because the commission is part of it. The
// H2 sandwich is closed by that same cap rather than by a second guard, so
// nothing is weakened — there is simply no second amount to disagree about.
//
// rate is NEVER a parameter here (removed 2026-07-20, see SettlementRate's
// doc): Ask derives its own settlement rate internally so SPEC §1.3b's
// manipulation defense cannot be silently bypassed by a caller — present or
// future — who forgets to pass the TWAP correctly. maxCredits (added the
// same day, an exploiter-scrutinizer finding) is the asker's own signed cap
// on how many credits this ask may cost, mirroring what transfer.allow
// already is for the commission's HBD leg — see the guard below for why it
// is needed even though rate itself is now tamper-resistant.
func Ask(s Store, caller, creator string, block uint64, maxCredits *big.Int, contentHash string, deadlineBlocks uint64, offeringID uint64) (*AskResult, error) {
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
	if err := validEventHash("contentHash", contentHash); err != nil {
		return nil, err
	}
	if maxCredits == nil || !mGt(maxCredits, mZero()) {
		// Reject a zero/absent cap rather than defaulting to unlimited: an
		// absent maxCredits is exactly the bug this parameter exists to
		// close (see the guard below).
		return nil, newErr(ErrInput, "maxCredits must be > 0")
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

	// The commission is a PARTITION of creditsSpent, taken off the SAME quote
	// the credits came from (settlePosted, settlement.go) rather than recomputed
	// here, so the quote the asker saw, the escrow that is written and the payout
	// that eventually happens are one number split one way, once.
	//
	// It is not separately gated: maxCredits above already bounds the total, and
	// the commission cannot exceed the total it is a fraction of. It IS clamped
	// defensively below — a commission larger than the escrow would let Answer
	// pay out more than was taken in, which is the one shape this record must
	// structurally forbid.
	commission := q.CommissionCredits
	if commission == nil || commission.Sign() < 0 {
		return nil, newErr(ErrArith, "settlement returned no commission split") // unreachable: settlePosted always sets it
	}
	if commission.Cmp(creditsSpent) > 0 {
		return nil, newErr(ErrArith, "commission exceeds the credits it is carved from") // unreachable at CommissionBps < 10000
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
	// THE TWO LEGS ARE RECORDED SEPARATELY (DEFECT FIX 2026-08-19, F2 + F17).
	// The clock stored below describes the MATURING leg ONLY; the matured leg is
	// recorded as a credit count in kEscrowMaturedLeg and carries no clock,
	// because a matured token does not have one. The old code collapsed the pair
	// into one size-weighted mean block, which was tax-neutral at THIS block and
	// then aged as a single pool for the whole escrow — letting the matured half,
	// whose own age was already capped and therefore free, donate decay to the
	// maturing half. One unanswered ask erased 100% of a holder's exit tax that
	// way. matured.go's ESCROW SPLIT block carries the full argument.
	// Graduate first, as Sell and Refund do (Phase-0 model: Ask was the one
	// value path that did not). Without it an asker whose position has cleared
	// the window has their tokens drawn from a maturing bucket that should
	// already be empty — so the escrow records a stale clock and, on reclaim or
	// decline, the tokens come back into the maturing family and are invisible
	// to the marketplace until an explicit Graduate. Every guard above has
	// passed, so this is in the write phase where a mutation is safe.
	graduate(s, creator, caller, block)
	// Only the matured leg needs recording: the maturing leg is whatever the
	// escrow's credits are not, so storing both would be one number too many
	// and a chance for the two to disagree.
	escFromMatured, escFromMaturing := splitDraw(s, creator, caller, creditsSpent)
	// Read the clock BEFORE the debit: draining the maturing bucket clears it.
	// This is the maturing leg's own clock, not a blend of anything.
	acqAtEscrow := holderAcqBlock(s, creator, caller)
	// ★ AND READ THE COHORTS, NOT JUST THE CLOCK (2026-09-08). acqAtEscrow above
	// is the maturing bucket's BLENDED clock, and a maturing bucket can be
	// heterogeneous: an aged pile plus a fresh slice. debitPosition draws the
	// maturing leg FRESHEST FIRST (lotsDebit), so what actually leaves is the
	// fresh cohorts — but crediting them back at the blend on Reclaim / Decline /
	// Answer re-stamped them with the aged pile's rate. Measured on the pre-fix
	// tree: one same-block Ask -> Decline turned 18,396 tokens owing 1,414 bps
	// into a cohort owing 51 bps, destroying 44% of the position's tax capacity,
	// and Reclaim reaches the same door permissionlessly one deadline later.
	// Recording the drawn cohorts is the same fix transfer.go took: a slice of
	// tokens carries its cohorts. Read BEFORE the debit, for the same reason the
	// clock is.
	escLots := lotsDrawFreshest(s, creator, caller, escFromMaturing)
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
		commissionCredits: commission,
		acqBlock:          acqAtEscrow,
		offeringID:        offeringID,
	})
	// The matured leg, keyed to the escrow that holds it. Written only when it
	// is non-zero so a wholly-maturing ask costs no extra state, and read back
	// as zero when absent — which is exactly how a pre-fix record behaves.
	if escFromMatured.Sign() > 0 {
		setMoney(s, kEscrowMaturedLeg(creator, seq), escFromMatured)
	}
	// The maturing leg's cohorts, keyed to the same escrow. Written only when
	// there is a maturing leg, and read back as absent — i.e. fall back to
	// acqAtEscrow — for every escrow written before this key existed.
	saveEscrowLots(s, creator, seq, escLots)
	setU64(s, kSeq(creator), seq+1)

	// DEFECT FIX (2026-07-20): the commission is HELD here, inside the escrow
	// record, and paid to NOBODY yet. SPEC §1.7.2 rule 4 is verbatim: "No
	// commission on refunds. When an ask is reclaimed unanswered, the asker gets
	// 100% back. We are paid for delivered service only." Settling it here,
	// before the creator has done anything, contradicted that rule and this
	// file's own I5 invariant — Answer (below) pays it on delivery; Reclaim and
	// Decline (below) return it, net of the one ruled miss slice.

	return &AskResult{Seq: seq, CreditsSpent: creditsSpent, CommissionCredits: commission, RateUsed: rate}, nil
}

// Answer pays the creator and resolves the escrow. Creator-only; escrow
// must be PENDING; legal ONLY while block <= deadline — the answer half of
// the I6 disjoint window. Deliberately consults NO phase/subscription
// state: legal in every phase including FROZEN (SPEC §1.7.5, API.md rule 4).
//
// Pays the commission held in the escrow (Ask, above) to the platform OWNER
// HERE, on delivery — never earlier. This is the "delivered service" half of
// SPEC §1.7.2 rule 4: the platform earns its 12% only once the creator has
// actually answered, proven by this call succeeding, not by the ask merely
// having been opened. Runs exactly once per escrow: Answer requires status ==
// PENDING and immediately flips it to ANSWERED before returning, so a second
// call on the same seq is rejected before it ever reaches this line — see
// TestAnswerBooksCommissionExactlyOnce.
//
// ★ THE COMMISSION IS TOKENS AND IT GOES TO AN ACCOUNT, NOT TO A BUCKET (OWNER
// RULING 2026-09-12). It used to be addMoney(kTreasury(), rec.commissionHbd) —
// an HBD credit to the contract's own treasury balance, withdrawable only by
// the owner-gated WithdrawTreasury. It is now a token credit to the owner
// account's ordinary position on THIS creator's market (Owner(s), read.go), so
// the platform holds the same instrument its customers do and exits the same
// way they do: Sell on the curve, paying the ordinary trade fee and exit tax.
// The contract never sells anything on the platform's behalf.
//
// WHEN NO OWNER IS BOUND (Owner(s) == "", i.e. Init has not run) the whole
// escrow goes to the creator and AnswerResult reports a zero commission. That
// is the only safe reading: the alternative is burning 12% of a paying
// customer's tokens into an account that does not exist.
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
	if err := validEventHash("answerHash", answerHash); err != nil {
		return nil, err
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
	//
	// F-C1/F-C8: bank the creator's OWN cleared position into the MATURED bucket
	// BEFORE these credits re-average into it. Without this, an aged pile that has
	// earned its way out of the exit tax gets its clock pulled back toward `block`
	// by the fresh inflow and becomes taxable again — the recipient "rides an aged
	// pile". graduate() is infallible and a no-op when nothing has aged out.
	graduate(s, creator, creator, block)
	owner := Owner(s)
	toCreator, toOwner, ownerGraduated := payEscrowToCreator(s, creator, owner, seq, rec.credits, rec.commissionCredits, rec.acqBlock, block)
	rec.status = askAnswered
	rec.answerHash = answerHash
	saveEscrow(s, creator, seq, rec)
	recordDelivery(s, creator, rec.asker) // delivery gate (delivery.go) — counters only

	// Report the account that was ACTUALLY credited, never the one that was
	// merely bound: a caller emitting a mint against an owner who received
	// nothing would put tokens on an indexer's books that no holder holds.
	paidOwner := ""
	if toOwner.Sign() > 0 {
		paidOwner = owner
	}
	return &AnswerResult{
		CreditsToCreator:  toCreator,
		CommissionToOwner: toOwner,
		OwnerGraduated:    ownerGraduated,
		Owner:             paidOwner,
	}, nil
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
// DEFECT FIX (2026-07-20): the commission was previously settled the instant
// Ask opened, and this function had no field to read it back from — an
// unanswered ask permanently cost the asker 12% of face, contradicting SPEC
// §1.7.2 rule 4 verbatim. Now the commission is only ever HELD in the escrow
// record (Ask) and only ever PAID on Answer, so Reclaim has nothing to reverse
// — it hands the escrow back net of the one ruled miss slice
// (MissReclaimSliceBps), exactly once (status flips to RECLAIMED before
// returning, so a second call is rejected before reaching here).
//
// ★ THE WRAPPER MOVES NOTHING ON THIS PATH ANY MORE (OWNER RULING 2026-09-12).
// It used to pay ReclaimResult.CommissionHbd back to the asker via
// sdk.HiveTransfer, state-first-transfer-second. The commission is tokens now
// and lives inside the same credits this function already returns internally,
// so there is no external leg left to order against — one fewer money call on a
// permissionless door.
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
	//
	// F-C1/F-C8: bank the asker's OWN cleared position into MATURED before the
	// returned credits re-average into it, so an aged pile that has earned its way
	// out of the exit tax cannot be re-aged (and re-taxed) by this inflow. The
	// graduated figure rides back in the result so the wrapper can emit the mint.
	graduated := graduate(s, creator, rec.asker, block)

	// USER RULING 1 (2026-07-28), the ONLY exception to I5's "no commission on
	// refunds": on a miss the protocol keeps MissReclaimSliceBps of the HELD
	// commission so that manufacturing a miss is not free (params.go carries the
	// full reasoning, including why the cost lands on the asker and why the
	// slice can never go to the creator). It is computed BEFORE the return so
	// the two are one partition of one escrow rather than a credit followed by a
	// debit — and it is taken in TOKENS, out of the commission portion of the
	// credits, because the HBD leg it used to come out of no longer exists
	// (OWNER RULING 2026-09-12).
	//
	// A SELF-DEALT escrow is not a miss (recordMiss returns immediately on
	// asker==creator), and the same condition governs the slice here, so the two
	// can never disagree about whether this was an offence.
	slice := mZero()
	if rec.asker != creator && rec.commissionCredits != nil && rec.commissionCredits.Sign() > 0 {
		slice = mMulDivCeil(rec.commissionCredits, new(big.Int).SetUint64(MissReclaimSliceBps), big.NewInt(10000))
	}
	returned, retained, ownerGraduated := returnEscrowToOwner(s, creator, rec.asker, Owner(s), seq, rec.credits, slice, rec.acqBlock, block)
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

	paidOwner := ""
	if retained.Sign() > 0 {
		paidOwner = Owner(s)
	}
	return &ReclaimResult{
		CreditsReturned:           returned,
		CommissionRetainedCredits: retained,
		Owner:                     paidOwner,
		OwnerGraduated:            ownerGraduated,
		Asker:                     rec.asker,
		Graduated:                 graduated,
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
// incentive to ignore asks instead. That is why the slice passed to
// returnEscrowToOwner below is nil and the owner is not even read.
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
// The wasm wrapper moves no money at all on this path (OWNER RULING
// 2026-09-12): the credits go back internally, here, and the HBD commission
// refund it used to pay to Result.Asker no longer exists.
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
	//
	// F-C1/F-C8: same as Reclaim — bank the asker's aged position into MATURED
	// before the returned credits re-average into it, so a decline cannot re-age
	// (and re-tax) a pile that had already earned its way out. graduate() is
	// infallible and a no-op when nothing has aged out.
	graduated := graduate(s, creator, rec.asker, block)
	returned, _, _ := returnEscrowToOwner(s, creator, rec.asker, "", seq, rec.credits, nil, rec.acqBlock, block)
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

	return &ReclaimResult{
		CreditsReturned:           returned,
		CommissionRetainedCredits: mZero(),
		Asker:                     rec.asker,
		Graduated:                 graduated,
	}, nil
}
