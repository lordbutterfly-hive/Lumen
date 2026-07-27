package core

import (
	"math/big"
	"reflect"
	"testing"
)

// ---- test helpers ---------------------------------------------------------

const (
	creator1 = "creator1"
	asker1   = "asker1"
	asker2   = "asker2"
	rando1   = "rando1"
)

// activateMarket sets up the minimal state an ACTIVE market needs for
// RequireInflowOpen(s, creator, block) to succeed: paid_until far beyond
// block. market.go (Agent 1 / market) is not yet written at the time this
// file was authored; kPaidUntil is documented in keys.go as "subscription
// expiry, block height" and is the only plausible per-market timing key
// Phase() can derive ACTIVE from, so this is the best-effort setup for
// Ask()-dependent tests. If Phase() ends up reading additional state this
// helper doesn't set, only the tests that go through Ask() (not the ones
// that construct escrows directly via saveEscrow) would need updating.
func activateMarket(s Store, creator string, block uint64) {
	setU64(s, kPaidUntil(creator), block+10*SubscriptionPeriod)
}

// stObsCount observations spaced LongObsSpacing apart satisfy BOTH rings
// (RULING C1): short (count 12 >= MinObsCount 8; span 11·6300 = 69,300 >=
// MinObsBlocks; clamped weight 11·2400 >= MinObsBlocks) and long (count 12
// >= LongMinObsCount 8; span 69,300 >= LongMinObsBlocks 57,600; clamped
// weight 11·6300 >= 57,600).
const stObsCount = 12

// seedSettleObs clears BOTH observation rings, then records stObsCount
// observations, all at `rate`, spaced LongObsSpacing (6300) blocks apart
// starting at `base`, and returns a query block 50 past the newest — never
// stale, deviation exactly zero in both windows (constant history: median ==
// every sample == rate), so SettlementRate returns exactly
// min(rate, SpotRate(supply)) whenever the C5 tripwire stays quiet.
//
// WHY THE OLD 200-BLOCK-SPACED seedConstantTwap IS GONE (RULING C): it
// satisfied only the SHORT ring; the long (7-day) ring samples at most one
// observation per 6300 blocks, so a 200-spaced series lands exactly ONE long
// sample and settlement refuses on the long window's minimum count — the
// young-market refusal the ruling mandates. Fixtures must now build a
// genuinely spanning history, like a real traded market would.
func seedSettleObs(s Store, creator string, base uint64, rate *big.Int) (queryBlock uint64) {
	resetObsRings(s, creator)
	for i := uint64(0); i < stObsCount; i++ {
		RecordObs(s, creator, base+i*LongObsSpacing, rate)
	}
	return base + (stObsCount-1)*LongObsSpacing + 50
}

// resetObsRings clears BOTH observation rings to known-empty. Fixtures use
// it after funding Buys (which feed the rings at the curve's own marginal
// rate — buy.go) so a hand-picked marker series can be written into clean
// rings without tripping the median-deviation guard against the funding
// rates. Not cheating: the marker series' own validity is still fully
// checked by both window reads.
func resetObsRings(s Store, creator string) {
	for i := uint64(0); i < ObsWindow; i++ {
		setStr(s, kObs(creator, i), "")
		setStr(s, kObsLong(creator, i), "")
	}
	setU64(s, kObsIdx(creator), 0)
	setU64(s, kObsLongIdx(creator), 0)
}

// curveMarket gives `creator` a curve state consistent with the equality
// invariant: supply S and reserve Area(S) exactly (R === area(S), C-9) —
// what a market that genuinely traded to S looks like. Needed because
// settlement (RULING C) reads supply (the spot arm, the depth ceiling, the
// spend cap) and reserve (the C5 divergence tripwire): the pre-RULING-C
// fixtures that ran asks against S == 0 markets would all refuse today.
// NOTE for fixtures that seed a marker rate BELOW the curve's average price
// (Area(S)/S >= BasePrice = 1000): set supply only and leave the reserve at
// zero, or C5 (ceil(R/S) > 4·rate) fires — see the rounding test below.
func curveMarket(s Store, creator string, supply int64) {
	setMoney(s, kSupply(creator), big.NewInt(supply))
	setMoney(s, kReserve(creator), Area(big.NewInt(supply)))
}

func mustBig(t *testing.T, s string) *big.Int {
	t.Helper()
	v, ok := new(big.Int).SetString(s, 10)
	if !ok {
		t.Fatalf("bad number %q", s)
	}
	return v
}

// mkPendingEscrow writes a PENDING escrow directly, bypassing Ask() (and
// therefore RequireInflowOpen) entirely. Answer and Reclaim tests use this
// so they exercise ONLY the escrow-resolution logic under test, not Agent
// 1's market.go / Agent 5's twap.go dependencies that Ask() pulls in.
// commissionHbd is a plain int64 for caller convenience; tests that don't
// care about the commission leg pass 0.
func mkPendingEscrow(s Store, creator string, seq uint64, asker string, credits int64, deadline uint64, contentHash string, commissionHbd int64) {
	saveEscrow(s, creator, seq, escrowRec{
		asker:         asker,
		credits:       big.NewInt(credits),
		deadline:      deadline,
		status:        askPending,
		contentHash:   contentHash,
		answerHash:    "",
		commissionHbd: big.NewInt(commissionHbd),
	})
}

func askErrSymbol(err error) string {
	if e, ok := err.(*Err); ok {
		return e.Symbol
	}
	return ""
}

// ---- Ask --------------------------------------------------------------

func TestAskHappyPath(t *testing.T) {
	s := NewMemStore()
	// RULING C fixture (replaces the PAR-era empty market): a real curve
	// state (S=100, R=Area(100)) and a full two-ring observation history at
	// a constant marker rate 400 — below SpotRate(100)=1813, so settlement
	// is min(400, 400, 1813) = 400 and creditsSpent = ceil(1000/400) = 3.
	// C5 stays quiet: ceil(Area(100)/100) = 1407 <= 4·400 = 1600.
	curveMarket(s, creator1, 100)
	setMoney(s, kFace(creator1), big.NewInt(1000)) // 1.000 HBD
	setMoney(s, kBal(creator1, asker1), big.NewInt(5000))
	block := seedSettleObs(s, creator1, 1000, big.NewInt(400))
	activateMarket(s, creator1, block)

	maxCredits := big.NewInt(3)
	commission := commissionOwedFor(big.NewInt(1000))
	if commission.Cmp(big.NewInt(120)) != 0 {
		t.Fatalf("sanity: commission = %s, want 120 (12%% of 1000)", commission)
	}

	res, err := askAt0(s, asker1, creator1, block, maxCredits, commission, "cid-1", MinAskDeadline)
	if err != nil {
		t.Fatalf("Ask: %v", err)
	}
	if res.Seq != 0 {
		t.Fatalf("Seq = %d, want 0", res.Seq)
	}
	if res.CreditsSpent.Cmp(big.NewInt(3)) != 0 {
		t.Fatalf("CreditsSpent = %s, want 3 (ceil(1000/400))", res.CreditsSpent)
	}
	if res.CommissionHbd.Cmp(commission) != 0 {
		t.Fatalf("CommissionHbd = %s, want %s", res.CommissionHbd, commission)
	}
	if res.RateUsed.Cmp(big.NewInt(400)) != 0 {
		t.Fatalf("RateUsed = %s, want 400 (the seeded settlement rate)", res.RateUsed)
	}

	if got := getMoney(s, kBal(creator1, asker1)); got.Cmp(big.NewInt(4997)) != 0 {
		t.Fatalf("asker balance = %s, want 4997 (5000-3)", got)
	}
	if got := getU64(s, kSeq(creator1)); got != 1 {
		t.Fatalf("kSeq = %d, want 1", got)
	}
	// DEFECT 1 FIX: the commission is HELD in escrow, NOT booked to the
	// treasury at Ask time — it only becomes revenue on a successful Answer
	// (delivered service). See TestAnswerBooksCommissionExactlyOnce and
	// TestReclaimReturnsCommissionInFull for the other two legs of the
	// round trip.
	if got := getMoney(s, kTreasury()); got.Sign() != 0 {
		t.Fatalf("treasury = %s, want 0 (commission held in escrow, not booked until Answer)", got)
	}

	rec, ok := loadEscrow(s, creator1, 0)
	if !ok {
		t.Fatal("escrow not found")
	}
	if rec.asker != asker1 {
		t.Fatalf("escrow.asker = %q, want %q", rec.asker, asker1)
	}
	if rec.credits.Cmp(big.NewInt(3)) != 0 {
		t.Fatalf("escrow.credits = %s, want 3", rec.credits)
	}
	if rec.deadline != block+MinAskDeadline {
		t.Fatalf("escrow.deadline = %d, want %d", rec.deadline, block+MinAskDeadline)
	}
	if rec.status != askPending {
		t.Fatalf("escrow.status = %q, want PENDING", rec.status)
	}
	if rec.contentHash != "cid-1" {
		t.Fatalf("escrow.contentHash = %q, want cid-1", rec.contentHash)
	}
	if rec.answerHash != "" {
		t.Fatalf("escrow.answerHash = %q, want empty", rec.answerHash)
	}
	if rec.commissionHbd.Cmp(commission) != 0 {
		t.Fatalf("escrow.commissionHbd = %s, want %s (held for Answer/Reclaim)", rec.commissionHbd, commission)
	}

	// The contract must never hold a creator-token balance for itself: no
	// kBal(creator, creator) entry was created by Ask (only by Answer).
	if _, ok := s.Get(kBal(creator1, creator1)); ok {
		t.Fatal("Ask must not credit the creator's own balance; that is Answer's job")
	}
}

func TestAskMaxCreditsMissingOrZeroRejected(t *testing.T) {
	s := NewMemStore()
	// No market setup needed: the maxCredits guard fires before
	// RequireInflowOpen is ever reached.
	_, err := askAt0(s, asker1, creator1, 1000, big.NewInt(0), big.NewInt(0), "cid", MinAskDeadline)
	if err == nil {
		t.Fatal("expected error for maxCredits=0")
	}
	if askErrSymbol(err) != ErrInput {
		t.Fatalf("symbol = %q, want %q (err=%v)", askErrSymbol(err), ErrInput, err)
	}

	_, err = askAt0(s, asker1, creator1, 1000, nil, big.NewInt(0), "cid", MinAskDeadline)
	if err == nil {
		t.Fatal("expected error for maxCredits=nil")
	}
	if askErrSymbol(err) != ErrInput {
		t.Fatalf("symbol = %q, want %q (err=%v)", askErrSymbol(err), ErrInput, err)
	}

	_, err = askAt0(s, asker1, creator1, 1000, big.NewInt(-5), big.NewInt(0), "cid", MinAskDeadline)
	if err == nil {
		t.Fatal("expected error for maxCredits<0")
	}
	if askErrSymbol(err) != ErrInput {
		t.Fatalf("symbol = %q, want %q (err=%v)", askErrSymbol(err), ErrInput, err)
	}
}

// TestAskMaxCreditsSlippageGuard proves the face-spike attack an exploiter
// scrutinizer found: `face` is creator-controlled (SetFace) and can move
// between when an asker signs a tx and when a block producer places it —
// intra-block order is producer-chosen, not consensus-enforced (verified at
// source; see twap.go's file doc for the identical fact applied to `rate`).
// Unlike `rate`, none of SPEC §1.3b's four oracle mitigations protect
// `face`: it needs its own, asker-signed cap. maxCredits is that cap,
// mirroring how transfer.allow already bounds the HBD leg of every other
// inflow in this codebase.
func TestAskMaxCreditsSlippageGuard(t *testing.T) {
	s := NewMemStore()
	// RULING C fixture: S=200 curve state, settlement rate 500. S is 200 —
	// not the canonical 100 — so the SPIKED ask below (8 credits) stays
	// under the 5%-of-supply spend cap (8·10000 <= 200·500 = 100,000) and
	// this test keeps proving the maxCredits guard SPECIFICALLY, not the
	// spend cap that now also exists in front of it (settlement.go). C5
	// quiet: ceil(Area(200)/200) = 1827 <= 4·500 = 2000.
	curveMarket(s, creator1, 200)
	setMoney(s, kFace(creator1), big.NewInt(1000)) // face the asker saw when they quoted/signed
	setMoney(s, kBal(creator1, asker1), big.NewInt(1_000_000))
	block := seedSettleObs(s, creator1, 1000, big.NewInt(500))
	activateMarket(s, creator1, block)

	// The asker quotes at face=1000, rate=500: creditsForAsk = 2, and
	// signs maxCredits=2 — willing to pay AT MOST what they quoted.
	maxCredits := big.NewInt(2)
	commission := commissionOwedFor(big.NewInt(1000))

	// ATTACK: the creator sneaks a face change into the same block, before
	// the asker's already-signed ask executes — no different in kind from a
	// real SetFace call landing first under producer-chosen ordering.
	// 4000 at rate 500 -> ceil = 8 credits, over the signed cap of 2.
	setMoney(s, kFace(creator1), big.NewInt(4000)) // 4x spike

	_, err := askAt0(s, asker1, creator1, block, maxCredits, commission, "cid", MinAskDeadline)
	if err == nil {
		t.Fatal("expected the spiked-face ask to revert, not silently spend more credits")
	}
	if askErrSymbol(err) != ErrInput {
		t.Fatalf("symbol = %q, want %q (err=%v)", askErrSymbol(err), ErrInput, err)
	}
	// Total no-op: nothing moved.
	if got := getMoney(s, kBal(creator1, asker1)); got.Cmp(big.NewInt(1_000_000)) != 0 {
		t.Fatalf("asker balance changed on reverted ask: %s", got)
	}
	if got := getU64(s, kSeq(creator1)); got != 0 {
		t.Fatalf("kSeq advanced on reverted ask: %d", got)
	}

	// A legitimate ask at EXACTLY maxCredits (face restored to what the
	// asker actually quoted) must still succeed — the guard must not be
	// off-by-one.
	setMoney(s, kFace(creator1), big.NewInt(1000))
	res, err := askAt0(s, asker1, creator1, block, maxCredits, commission, "cid", MinAskDeadline)
	if err != nil {
		t.Fatalf("ask at exactly maxCredits should succeed: %v", err)
	}
	if res.CreditsSpent.Cmp(maxCredits) != 0 {
		t.Fatalf("CreditsSpent = %s, want exactly maxCredits %s", res.CreditsSpent, maxCredits)
	}
}

func TestAskCommissionUnderpaidRejected(t *testing.T) {
	s := NewMemStore()
	// RULING C fixture: canonical S=100 / rate 400 market (TestAskHappyPath
	// has the math) — creditsForAsk(1000,400) = 3, so maxCredits=3 covers
	// it and the ask reaches the commission check this test is about.
	curveMarket(s, creator1, 100)
	setMoney(s, kFace(creator1), big.NewInt(1000))
	setMoney(s, kBal(creator1, asker1), big.NewInt(5000))
	block := seedSettleObs(s, creator1, 1000, big.NewInt(400))
	activateMarket(s, creator1, block)

	maxCredits := big.NewInt(3)
	owed := commissionOwedFor(big.NewInt(1000)) // 120
	underpaid := new(big.Int).Sub(owed, big.NewInt(1))

	_, err := askAt0(s, asker1, creator1, block, maxCredits, underpaid, "cid", MinAskDeadline)
	if err == nil {
		t.Fatal("expected error for underpaid commission")
	}
	if askErrSymbol(err) != ErrBalance {
		t.Fatalf("symbol = %q, want %q (err=%v)", askErrSymbol(err), ErrBalance, err)
	}

	// Rejected ask must be a total no-op: no credits moved, no seq consumed,
	// no treasury booking.
	if got := getMoney(s, kBal(creator1, asker1)); got.Cmp(big.NewInt(5000)) != 0 {
		t.Fatalf("asker balance changed on rejected ask: %s", got)
	}
	if got := getU64(s, kSeq(creator1)); got != 0 {
		t.Fatalf("kSeq advanced on rejected ask: %d", got)
	}
	if got := getMoney(s, kTreasury()); got.Sign() != 0 {
		t.Fatalf("treasury changed on rejected ask: %s", got)
	}

	// Exactly the floor amount must be accepted.
	res, err := askAt0(s, asker1, creator1, block, maxCredits, owed, "cid", MinAskDeadline)
	if err != nil {
		t.Fatalf("exact commission should be accepted: %v", err)
	}
	if res.CommissionHbd.Cmp(owed) != 0 {
		t.Fatalf("CommissionHbd = %s, want %s", res.CommissionHbd, owed)
	}
}

// TestAskCommissionOverpaidRejected is H2's regression proof: before the
// fix, the commission check was a LOWER bound
// (commissionHbdPaid >= commissionOwedFor(face)), so any amount above the
// true owed commission was silently accepted, HELD in full, and (on Answer)
// booked to the treasury in full — up to 4x the true commission on a
// band-legal SetFace drop between the asker's quote and this call's
// execution, with no way back since the treasury (C2) had no exit. The fix
// makes the check an EXACT match: an asker who overpays is now refused,
// exactly the way an underpaying asker always was.
func TestAskCommissionOverpaidRejected(t *testing.T) {
	s := NewMemStore()
	// RULING C fixture: canonical S=100 / rate 400 market (TestAskHappyPath
	// has the math).
	curveMarket(s, creator1, 100)
	setMoney(s, kFace(creator1), big.NewInt(1000))
	setMoney(s, kBal(creator1, asker1), big.NewInt(5000))
	block := seedSettleObs(s, creator1, 1000, big.NewInt(400))
	activateMarket(s, creator1, block)

	maxCredits := big.NewInt(3)
	owed := commissionOwedFor(big.NewInt(1000)) // 120
	overpaid := new(big.Int).Add(owed, big.NewInt(1))

	_, err := askAt0(s, asker1, creator1, block, maxCredits, overpaid, "cid", MinAskDeadline)
	if err == nil {
		t.Fatal("REGRESSION: an overpaid commission was accepted — the old >= lower-bound check is back")
	}
	if askErrSymbol(err) != ErrBalance {
		t.Fatalf("symbol = %q, want %q (err=%v)", askErrSymbol(err), ErrBalance, err)
	}

	// Total no-op: nothing moved, nothing held.
	if got := getMoney(s, kBal(creator1, asker1)); got.Cmp(big.NewInt(5000)) != 0 {
		t.Fatalf("asker balance changed on rejected ask: %s", got)
	}
	if got := getU64(s, kSeq(creator1)); got != 0 {
		t.Fatalf("kSeq advanced on rejected ask: %d", got)
	}

	// A GROSSLY overpaid commission (a 4x-style spike, the exact shape H2
	// names) must be refused the same way, not just an off-by-one.
	grosslyOverpaid := new(big.Int).Mul(owed, big.NewInt(4))
	if _, err := askAt0(s, asker1, creator1, block, maxCredits, grosslyOverpaid, "cid", MinAskDeadline); err == nil {
		t.Fatal("REGRESSION: a 4x-overpaid commission was accepted")
	} else if askErrSymbol(err) != ErrBalance {
		t.Fatalf("symbol = %q, want %q (err=%v)", askErrSymbol(err), ErrBalance, err)
	}

	// Exactly the owed amount must still be accepted — the fix must not have
	// tightened the bound into rejecting the correct value too.
	res, err := askAt0(s, asker1, creator1, block, maxCredits, owed, "cid", MinAskDeadline)
	if err != nil {
		t.Fatalf("exact commission should be accepted: %v", err)
	}
	if res.CommissionHbd.Cmp(owed) != 0 {
		t.Fatalf("CommissionHbd = %s, want exactly %s (held, not the overpaid amount)", res.CommissionHbd, owed)
	}
}

// TestCreditsForAskCeilsNotFloors proves the pure rounding math never
// floors, on awkward face/rate combinations, independent of Ask()'s other
// dependencies.
func TestCreditsForAskCeilsNotFloors(t *testing.T) {
	cases := []struct {
		face, rate string
	}{
		{"1000", "1"}, // exact: 1000
		{"101", "10"}, // 10.1 -> 11, not 10
		{"5", "1000"}, // 0.005 -> 1, not 0 (would floor to zero and be rejected)
		{"999999999999", "7"},
		{"3", "3"},            // exact: 1
		{"7", "3"},            // 2.33.. -> 3
		{"1", "999999999999"}, // -> 1, never 0
	}
	for _, c := range cases {
		face := mustBig(t, c.face)
		rate := mustBig(t, c.rate)

		q := new(big.Int)
		r := new(big.Int)
		q.QuoRem(face, rate, r) // floor division for non-negative operands
		wantCeil := new(big.Int).Set(q)
		hasRemainder := r.Sign() != 0
		if hasRemainder {
			wantCeil.Add(wantCeil, big.NewInt(1))
		}

		got := creditsForAsk(face, rate)
		if got.Cmp(wantCeil) != 0 {
			t.Fatalf("creditsForAsk(%s,%s) = %s, want ceil = %s", c.face, c.rate, got, wantCeil)
		}
		if hasRemainder && got.Cmp(q) == 0 {
			t.Fatalf("creditsForAsk(%s,%s) = %s equals the FLOOR %s; must round up, never down", c.face, c.rate, got, q)
		}
		if !mGt(got, mZero()) {
			t.Fatalf("creditsForAsk(%s,%s) = %s, must be > 0", c.face, c.rate, got)
		}
	}
}

// TestAskCreditsRoundingWiredCorrectly proves Ask() actually uses the
// ceiling helper end-to-end, not a copy that happens to floor — sourcing
// its rate from a real seeded TWAP so the test still exercises a rate other
// than the PAR fallback.
func TestAskCreditsRoundingWiredCorrectly(t *testing.T) {
	s := NewMemStore()
	// Rate 10 is far below the curve's average price (>= BasePrice 1000), so
	// this fixture sets SUPPLY ONLY and leaves the reserve at zero — with a
	// real R = Area(S) the C5 tripwire (ceil(R/S) > 4·rate) would fire, by
	// design, on a rate this depressed. Zero reserve keeps the tripwire
	// quiet so the test can isolate its actual subject: the ceil wiring.
	// S=250 clears the spend cap for 11 credits (11·10000 <= 250·500).
	setMoney(s, kSupply(creator1), big.NewInt(250))
	setMoney(s, kFace(creator1), big.NewInt(101))
	setMoney(s, kBal(creator1, asker1), big.NewInt(1_000_000))

	askBlock := seedSettleObs(s, creator1, 1000, big.NewInt(10))
	activateMarket(s, creator1, askBlock)

	commission := commissionOwedFor(big.NewInt(101))
	res, err := askAt0(s, asker1, creator1, askBlock, big.NewInt(20), commission, "cid", MinAskDeadline)
	if err != nil {
		t.Fatalf("Ask: %v", err)
	}
	if res.RateUsed.Cmp(big.NewInt(10)) != 0 {
		t.Fatalf("RateUsed = %s, want 10 (the seeded TWAP)", res.RateUsed)
	}
	// ceil(101/10) = 11, floor would be 10.
	if res.CreditsSpent.Cmp(big.NewInt(11)) != 0 {
		t.Fatalf("CreditsSpent = %s, want 11 (ceil of 101/10)", res.CreditsSpent)
	}
	if got := getMoney(s, kBal(creator1, asker1)); got.Cmp(big.NewInt(1_000_000-11)) != 0 {
		t.Fatalf("asker balance = %s, want %d", got, 1_000_000-11)
	}
}

func TestAskDeadlineOutOfBandRejected(t *testing.T) {
	s := NewMemStore()
	// No market setup needed: the deadline-band guard fires before
	// RequireInflowOpen.
	_, err := askAt0(s, asker1, creator1, 1000, big.NewInt(1), big.NewInt(0), "cid", MinAskDeadline-1)
	if err == nil || askErrSymbol(err) != ErrInput {
		t.Fatalf("below MinAskDeadline: err=%v, want ErrInput", err)
	}
	_, err = askAt0(s, asker1, creator1, 1000, big.NewInt(1), big.NewInt(0), "cid", MaxAskDeadline+1)
	if err == nil || askErrSymbol(err) != ErrInput {
		t.Fatalf("above MaxAskDeadline: err=%v, want ErrInput", err)
	}
}

// TestAskSignatureCannotAcceptCallerSuppliedRate is a regression guard for
// the 2026-07-20 defect fix: core.Ask must derive its settlement rate
// internally (SettlementRate) rather than accept one as a parameter — SPEC
// §1.3b's entire manipulation defense used to depend on every present and
// future CALLER remembering to pass the TWAP correctly, which was exactly
// the footgun this removes. Checked via reflection so a well-meaning future
// edit that re-adds a `rate *big.Int` parameter fails immediately, at the
// API-shape level, instead of silently reopening the footgun.
func TestAskSignatureCannotAcceptCallerSuppliedRate(t *testing.T) {
	fn := reflect.TypeOf(Ask)
	if fn.Kind() != reflect.Func {
		t.Fatal("core.Ask is not a function")
	}
	// s, caller, creator, block, maxCredits, commissionHbdPaid, contentHash,
	// deadlineBlocks, offeringID (2026-07-27 — which named service this ask
	// buys; 0 == the legacy `face` price). Still no `rate`: the settlement
	// rate remains derived inside core, never caller-supplied, which is the
	// property this test exists to pin.
	const wantParams = 9
	if fn.NumIn() != wantParams {
		t.Fatalf("core.Ask has %d parameters, want %d — signature shape changed; re-verify no `rate` parameter was reintroduced", fn.NumIn(), wantParams)
	}
	bigIntParams := 0
	for i := 0; i < fn.NumIn(); i++ {
		if fn.In(i).String() == "*big.Int" {
			bigIntParams++
		}
	}
	// Exactly TWO *big.Int parameters: maxCredits (the asker's own
	// slippage cap) and commissionHbdPaid. A THIRD would mean a
	// caller-suppliable `rate` crept back in, silently defeating SPEC
	// §1.3b's TWAP defense.
	if bigIntParams != 2 {
		t.Fatalf("core.Ask has %d *big.Int parameters, want exactly 2 (maxCredits, commissionHbdPaid) — a third suggests a caller-suppliable `rate` was reintroduced", bigIntParams)
	}
}

// ---- SettlementRate (RULING C: refusal, never PAR) -------------------------
//
// WHAT THE DELETED TESTS HERE ASSERTED AND WHY THEY WERE WRONG: the four
// PAR-era tests (TestSettlementRate_PARWhenOracleUnavailable,
// TestAsk_SettlesAtPARWhenOracleUnavailable, and the two TWAP-switchover
// twins) pinned the OLD ruled behaviour — "PAR when the oracle can't price"
// — as correct. RULING C overturned it: PAR is wrong by exactly the factor
// `spot`, always against the asker (a MinFace 0.1 HBD service against a
// 100-unit token cost 100 tokens at PAR where correct pricing costs 1), and
// it fired on ordinary conditions. The replacements below pin the ruled
// behaviour: settlement REFUSES with a typed error, and prices at
// min(TWAP_short, TWAP_long, spot) when it can price. Deeper settlement
// coverage (each min arm, every guard boundary, the attacker walk, the
// no-outflow-gated proof) lives in settlement_test.go.

func TestSettlementRate_RefusesWhenOracleUnavailable(t *testing.T) {
	s := NewMemStore()
	// A market with supply but NO observations: both windows must refuse,
	// so SettlementRate must return a typed ORACLE error — never PAR, never
	// zero, never a made-up rate.
	curveMarket(s, creator1, 100)
	_, err := SettlementRate(s, creator1, 1000)
	if err == nil {
		t.Fatal("REGRESSION: SettlementRate returned a rate with no observations — the PAR fallback is back")
	}
	if askErrSymbol(err) != ErrOracle {
		t.Fatalf("symbol = %q, want %q (err=%v)", askErrSymbol(err), ErrOracle, err)
	}
}

func TestSettlementRate_RefusesOnZeroSupply(t *testing.T) {
	s := NewMemStore()
	// Even a full, valid observation history cannot price a market with no
	// supply: there is no token to settle in (and SpotRate(0) == 0 by the
	// package convention). Must refuse, not return 0.
	queryBlock := seedSettleObs(s, creator1, 10_000, big.NewInt(2500))
	_, err := SettlementRate(s, creator1, queryBlock)
	if err == nil {
		t.Fatal("SettlementRate priced a zero-supply market")
	}
	if askErrSymbol(err) != ErrOracle {
		t.Fatalf("symbol = %q, want %q (err=%v)", askErrSymbol(err), ErrOracle, err)
	}
}

func TestSettlementRate_TWAPWhenAvailable(t *testing.T) {
	s := NewMemStore()
	// S=200: SpotRate(200)=2680 > 2500, so min(2500, 2500, 2680) = 2500 —
	// the constant seeded history prices exactly. C5 quiet: ceil(Area(200)/
	// 200) = 1827 <= 4·2500.
	curveMarket(s, creator1, 200)
	queryBlock := seedSettleObs(s, creator1, 10_000, big.NewInt(2500))
	got, err := SettlementRate(s, creator1, queryBlock)
	if err != nil {
		t.Fatalf("SettlementRate with a valid two-ring history: %v", err)
	}
	if got.Cmp(big.NewInt(2500)) != 0 {
		t.Fatalf("SettlementRate = %s, want the TWAP 2500", got)
	}
}

// TestAsk_RefusesWhenOracleUnavailable proves Ask() itself — not just the
// SettlementRate helper — REFUSES cleanly (typed error, total no-op) for a
// market with no usable observation history, instead of settling at PAR as
// the pre-RULING-C version did.
func TestAsk_RefusesWhenOracleUnavailable(t *testing.T) {
	s := NewMemStore()
	const block = uint64(1000)
	curveMarket(s, creator1, 100)
	activateMarket(s, creator1, block)
	setMoney(s, kFace(creator1), big.NewInt(1000))
	setMoney(s, kBal(creator1, asker1), big.NewInt(5000))

	commission := commissionOwedFor(big.NewInt(1000))
	_, err := askAt0(s, asker1, creator1, block, big.NewInt(1000), commission, "cid", MinAskDeadline)
	if err == nil {
		t.Fatal("REGRESSION: Ask succeeded with no oracle — the PAR fallback is back")
	}
	if askErrSymbol(err) != ErrOracle {
		t.Fatalf("symbol = %q, want %q (err=%v)", askErrSymbol(err), ErrOracle, err)
	}
	// Refusal is a total no-op (RULING G: nothing mutates on a rejected call).
	if got := getMoney(s, kBal(creator1, asker1)); got.Cmp(big.NewInt(5000)) != 0 {
		t.Fatalf("asker balance changed on refused ask: %s", got)
	}
	if got := getU64(s, kSeq(creator1)); got != 0 {
		t.Fatalf("kSeq advanced on refused ask: %d", got)
	}
}

// TestAsk_SettlesAtTWAPWhenAvailable proves Ask() prices off the min() the
// moment a market has enough valid observations in BOTH windows.
func TestAsk_SettlesAtTWAPWhenAvailable(t *testing.T) {
	s := NewMemStore()
	// S=200 so the spot arm (2680) sits ABOVE the seeded 2000 and the min
	// resolves to the TWAP; C4 boundary passes exactly (face·2 == rate).
	curveMarket(s, creator1, 200)
	setMoney(s, kFace(creator1), big.NewInt(1000))
	setMoney(s, kBal(creator1, asker1), big.NewInt(5000))
	askBlock := seedSettleObs(s, creator1, 1000, big.NewInt(2000))
	activateMarket(s, creator1, askBlock)

	commission := commissionOwedFor(big.NewInt(1000))
	wantCredits := creditsForAsk(big.NewInt(1000), big.NewInt(2000)) // ceil(1000/2000) = 1

	res, err := askAt0(s, asker1, creator1, askBlock, wantCredits, commission, "cid", MinAskDeadline)
	if err != nil {
		t.Fatalf("Ask: %v", err)
	}
	if res.RateUsed.Cmp(big.NewInt(2000)) != 0 {
		t.Fatalf("RateUsed = %s, want the TWAP 2000", res.RateUsed)
	}
	if res.CreditsSpent.Cmp(wantCredits) != 0 {
		t.Fatalf("CreditsSpent = %s, want %s", res.CreditsSpent, wantCredits)
	}
}

// ---- Answer -------------------------------------------------------------

func TestAnswerHappyPath(t *testing.T) {
	s := NewMemStore()
	const deadline = uint64(500)
	mkPendingEscrow(s, creator1, 0, asker1, 42, deadline, "cid", 5)

	res, err := Answer(s, creator1, creator1, 400, 0, "answer-hash")
	if err != nil {
		t.Fatalf("Answer: %v", err)
	}
	if res.CreditsToCreator.Cmp(big.NewInt(42)) != 0 {
		t.Fatalf("CreditsToCreator = %s, want 42", res.CreditsToCreator)
	}
	// CommissionHbd (added 2026-07-21, at the indexer agent's request): the
	// wrapper's EvAnswered needs the booked amount to reconstruct the
	// answered->treasury HBD flow from the event stream, mirroring
	// ReclaimResult.CommissionHbd's existing shape on the reclaim side.
	if res.CommissionHbd.Cmp(big.NewInt(5)) != 0 {
		t.Fatalf("CommissionHbd = %s, want 5 (the exact amount booked to the treasury)", res.CommissionHbd)
	}
	if got := getMoney(s, kBal(creator1, creator1)); got.Cmp(big.NewInt(42)) != 0 {
		t.Fatalf("creator balance = %s, want 42", got)
	}
	if got := getMoney(s, kTreasury()); got.Cmp(big.NewInt(5)) != 0 {
		t.Fatalf("treasury = %s, want 5 (commission booked on Answer)", got)
	}
	rec, ok := loadEscrow(s, creator1, 0)
	if !ok || rec.status != askAnswered || rec.answerHash != "answer-hash" {
		t.Fatalf("escrow after answer = %+v (ok=%v)", rec, ok)
	}
}

func TestAnswerByNonCreatorRejected(t *testing.T) {
	s := NewMemStore()
	mkPendingEscrow(s, creator1, 0, asker1, 42, 500, "cid", 0)

	_, err := Answer(s, rando1, creator1, 400, 0, "answer-hash")
	if err == nil || askErrSymbol(err) != ErrAuth {
		t.Fatalf("non-creator answer: err=%v, want ErrAuth", err)
	}
	if got := getMoney(s, kBal(creator1, creator1)); got.Sign() != 0 {
		t.Fatalf("creator balance changed on rejected answer: %s", got)
	}
}

func TestAnswerDoubleRejected(t *testing.T) {
	s := NewMemStore()
	mkPendingEscrow(s, creator1, 0, asker1, 42, 500, "cid", 0)

	if _, err := Answer(s, creator1, creator1, 400, 0, "answer-hash"); err != nil {
		t.Fatalf("first answer: %v", err)
	}
	balAfterFirst := getMoney(s, kBal(creator1, creator1))

	_, err := Answer(s, creator1, creator1, 401, 0, "second-hash")
	if err == nil || askErrSymbol(err) != ErrState {
		t.Fatalf("double answer: err=%v, want ErrState", err)
	}
	if got := getMoney(s, kBal(creator1, creator1)); got.Cmp(balAfterFirst) != 0 {
		t.Fatalf("double answer paid again: %s -> %s", balAfterFirst, got)
	}
}

func TestAnswerAfterDeadlineRejected(t *testing.T) {
	s := NewMemStore()
	const deadline = uint64(500)
	mkPendingEscrow(s, creator1, 0, asker1, 42, deadline, "cid", 0)

	_, err := Answer(s, creator1, creator1, deadline+1, 0, "answer-hash")
	if err == nil || askErrSymbol(err) != ErrState {
		t.Fatalf("answer past deadline: err=%v, want ErrState", err)
	}
	if got := getMoney(s, kBal(creator1, creator1)); got.Sign() != 0 {
		t.Fatalf("creator paid despite late answer: %s", got)
	}
	// block == deadline is still legal (the boundary is inclusive).
	if _, err := Answer(s, creator1, creator1, deadline, 0, "answer-hash"); err != nil {
		t.Fatalf("answer AT deadline should succeed: %v", err)
	}
}

// TestAnswerWhileFrozenSucceeds proves the hard SPEC §1.7.5 requirement: "a
// creator mid-answer when their subscription lapses still gets paid for
// finishing the work." The escrow is built directly (mkPendingEscrow), so
// this in no way depends on Ask()/RequireInflowOpen — it isolates Answer()
// itself and shows it never consults phase/billing state at all.
func TestAnswerWhileFrozenSucceeds(t *testing.T) {
	s := NewMemStore()
	const deadline = uint64(500)
	// Simulate a deeply lapsed, FROZEN market: paid_until in the past well
	// beyond any grace window, and the (non-authoritative, per API.md Phase
	// doc) state marker set to FROZEN too, for good measure.
	setU64(s, kPaidUntil(creator1), 1)
	setStr(s, kState(creator1), StateFrozen)
	mkPendingEscrow(s, creator1, 0, asker1, 42, deadline, "cid", 0)

	res, err := Answer(s, creator1, creator1, 400, 0, "answer-hash")
	if err != nil {
		t.Fatalf("Answer while FROZEN must succeed, got: %v", err)
	}
	if res.CreditsToCreator.Cmp(big.NewInt(42)) != 0 {
		t.Fatalf("CreditsToCreator = %s, want 42", res.CreditsToCreator)
	}
}

// TestAnswerBooksCommissionExactlyOnce drives a REAL Ask (not a synthetic
// escrow) through Answer and proves the commission moves to the treasury
// exactly once: not at Ask time (defect fix), exactly once at Answer time,
// and never again on a rejected double-answer.
func TestAnswerBooksCommissionExactlyOnce(t *testing.T) {
	s := NewMemStore()
	// RULING C fixture: canonical S=100 / rate 400 market (TestAskHappyPath
	// has the math) — 3 credits per 1000-face ask.
	curveMarket(s, creator1, 100)
	setMoney(s, kFace(creator1), big.NewInt(1000))
	setMoney(s, kBal(creator1, asker1), big.NewInt(5000))
	block := seedSettleObs(s, creator1, 1000, big.NewInt(400))
	activateMarket(s, creator1, block)

	commission := commissionOwedFor(big.NewInt(1000))
	maxCredits := big.NewInt(3)

	askRes, err := askAt0(s, asker1, creator1, block, maxCredits, commission, "cid", MinAskDeadline)
	if err != nil {
		t.Fatalf("Ask: %v", err)
	}
	if got := getMoney(s, kTreasury()); got.Sign() != 0 {
		t.Fatalf("treasury after Ask = %s, want 0 (commission HELD in escrow, not booked yet)", got)
	}

	answerRes, err := Answer(s, creator1, creator1, block+10, askRes.Seq, "ans")
	if err != nil {
		t.Fatalf("Answer: %v", err)
	}
	if got := getMoney(s, kTreasury()); got.Cmp(commission) != 0 {
		t.Fatalf("treasury after Answer = %s, want exactly %s (commission booked on delivery)", got, commission)
	}
	if answerRes.CommissionHbd.Cmp(commission) != 0 {
		t.Fatalf("AnswerResult.CommissionHbd = %s, want exactly %s (what was actually booked)", answerRes.CommissionHbd, commission)
	}

	// Double-answer must be rejected AND must not double-book.
	_, err = Answer(s, creator1, creator1, block+11, askRes.Seq, "ans2")
	if err == nil || askErrSymbol(err) != ErrState {
		t.Fatalf("double answer: err=%v, want ErrState", err)
	}
	if got := getMoney(s, kTreasury()); got.Cmp(commission) != 0 {
		t.Fatalf("treasury after double-answer attempt = %s, want still exactly %s (booked exactly once)", got, commission)
	}
}

// ---- Reclaim ------------------------------------------------------------

func TestReclaimHappyPath(t *testing.T) {
	s := NewMemStore()
	const deadline = uint64(500)
	mkPendingEscrow(s, creator1, 0, asker1, 42, deadline, "cid", 0)

	block := deadline + ReclaimGrace + 1
	got, err := Reclaim(s, asker1, creator1, block, 0)
	if err != nil {
		t.Fatalf("Reclaim: %v", err)
	}
	if got.CreditsReturned.Cmp(big.NewInt(42)) != 0 {
		t.Fatalf("reclaimed = %s, want 42 (full amount)", got.CreditsReturned)
	}
	if bal := getMoney(s, kBal(creator1, asker1)); bal.Cmp(big.NewInt(42)) != 0 {
		t.Fatalf("asker balance = %s, want 42", bal)
	}
	rec, ok := loadEscrow(s, creator1, 0)
	if !ok || rec.status != askReclaimed {
		t.Fatalf("escrow after reclaim = %+v (ok=%v)", rec, ok)
	}
}

// TestReclaimByThirdPartyAfterWindowPaysAsker is H1's core fix proof:
// PERMISSIONLESS reclaim once the window is open. Before the fix, this exact
// call (a non-asker calling Reclaim) was rejected with ErrAuth — which is
// precisely the defect: Ask debits kBal but not kSupply, so an abandoned
// PENDING escrow keeps supply>0 forever unless SOMEONE resolves it, and
// asker-only reclaim means an asker who simply never comes back permanently
// bricks the creator's market (CloseIfDrained needs supply==0;
// Register's duplicate guard needs CLOSED). This proves a totally unrelated
// third party (rando1) can now push the reclaim — and that doing so pays
// the RIGHTFUL asker (asker1), never the caller (rando1), the same
// "anyone may push, only the owner is ever paid" shape RefundHolder already
// has.
func TestReclaimByThirdPartyAfterWindowPaysAsker(t *testing.T) {
	s := NewMemStore()
	const deadline = uint64(500)
	mkPendingEscrow(s, creator1, 0, asker1, 42, deadline, "cid", 7)

	block := deadline + ReclaimGrace + 1
	res, err := Reclaim(s, rando1, creator1, block, 0)
	if err != nil {
		t.Fatalf("third-party reclaim after the window opened must succeed: %v", err)
	}
	if res.Asker != asker1 {
		t.Fatalf("ReclaimResult.Asker = %q, want %q (the escrow's own asker)", res.Asker, asker1)
	}
	if res.CreditsReturned.Cmp(big.NewInt(42)) != 0 {
		t.Fatalf("CreditsReturned = %s, want 42", res.CreditsReturned)
	}
	if res.CommissionHbd.Cmp(big.NewInt(7)) != 0 {
		t.Fatalf("CommissionHbd = %s, want 7", res.CommissionHbd)
	}

	// The MONEY lands on the asker, never on rando1 (the caller) — this is
	// the load-bearing part of the fix: permissionless does not mean
	// redirectable.
	if bal := getMoney(s, kBal(creator1, asker1)); bal.Cmp(big.NewInt(42)) != 0 {
		t.Fatalf("asker balance = %s, want 42 (credited to the ASKER)", bal)
	}
	if bal := getMoney(s, kBal(creator1, rando1)); bal.Sign() != 0 {
		t.Fatalf("caller (rando1) balance = %s, want 0 (caller must never be paid)", bal)
	}

	rec, ok := loadEscrow(s, creator1, 0)
	if !ok || rec.status != askReclaimed {
		t.Fatalf("escrow after third-party reclaim = %+v (ok=%v)", rec, ok)
	}
}

// TestReclaimByThirdPartyBeforeWindowStillRejected proves permissionless
// reclaim did NOT also open an early-reclaim hole: the window-not-open guard
// applies identically regardless of who calls, asker or stranger.
func TestReclaimByThirdPartyBeforeWindowStillRejected(t *testing.T) {
	s := NewMemStore()
	const deadline = uint64(500)

	// Mid-answer-window: not reclaimable by anyone, asker or stranger.
	mkPendingEscrow(s, creator1, 0, asker1, 42, deadline, "cid", 0)
	if _, err := Reclaim(s, rando1, creator1, deadline, 0); err == nil || askErrSymbol(err) != ErrState {
		t.Fatalf("third-party reclaim mid-window: err=%v, want ErrState", err)
	}

	// Exactly at the grace boundary: still not open (must be STRICTLY >).
	mkPendingEscrow(s, creator1, 1, asker1, 42, deadline, "cid", 0)
	if _, err := Reclaim(s, rando1, creator1, deadline+ReclaimGrace, 1); err == nil || askErrSymbol(err) != ErrState {
		t.Fatalf("third-party reclaim at the grace boundary: err=%v, want ErrState", err)
	}

	if bal := getMoney(s, kBal(creator1, asker1)); bal.Sign() != 0 {
		t.Fatalf("asker balance changed by a rejected reclaim attempt: %s", bal)
	}
	if bal := getMoney(s, kBal(creator1, rando1)); bal.Sign() != 0 {
		t.Fatalf("rando1 balance changed by a rejected reclaim attempt: %s", bal)
	}
}

// TestReclaimEmptyCallerRejected mirrors RefundHolder's identical guard on
// its own permissionless `caller` parameter: a completely absent caller is
// still refused, even though ANY non-empty caller is now accepted.
func TestReclaimEmptyCallerRejected(t *testing.T) {
	s := NewMemStore()
	const deadline = uint64(500)
	mkPendingEscrow(s, creator1, 0, asker1, 42, deadline, "cid", 0)

	block := deadline + ReclaimGrace + 1
	_, err := Reclaim(s, "", creator1, block, 0)
	if err == nil || askErrSymbol(err) != ErrAuth {
		t.Fatalf("empty-caller reclaim: err=%v, want ErrAuth", err)
	}
	if bal := getMoney(s, kBal(creator1, asker1)); bal.Sign() != 0 {
		t.Fatalf("asker balance changed on rejected reclaim: %s", bal)
	}
}

func TestReclaimDoubleRejected(t *testing.T) {
	s := NewMemStore()
	const deadline = uint64(500)
	mkPendingEscrow(s, creator1, 0, asker1, 42, deadline, "cid", 0)

	block := deadline + ReclaimGrace + 1
	if _, err := Reclaim(s, asker1, creator1, block, 0); err != nil {
		t.Fatalf("first reclaim: %v", err)
	}
	balAfterFirst := getMoney(s, kBal(creator1, asker1))

	_, err := Reclaim(s, asker1, creator1, block+1, 0)
	if err == nil || askErrSymbol(err) != ErrState {
		t.Fatalf("double reclaim: err=%v, want ErrState", err)
	}
	if got := getMoney(s, kBal(creator1, asker1)); got.Cmp(balAfterFirst) != 0 {
		t.Fatalf("double reclaim paid again: %s -> %s", balAfterFirst, got)
	}
}

func TestReclaimBeforeWindowRejected(t *testing.T) {
	s := NewMemStore()
	const deadline = uint64(500)

	// Mid-answer-window: clearly not reclaimable.
	mkPendingEscrow(s, creator1, 0, asker1, 42, deadline, "cid", 0)
	if _, err := Reclaim(s, asker1, creator1, deadline, 0); err == nil || askErrSymbol(err) != ErrState {
		t.Fatalf("reclaim at deadline: err=%v, want ErrState", err)
	}

	// Exactly at the grace boundary: still not open (must be STRICTLY >).
	mkPendingEscrow(s, creator1, 1, asker1, 42, deadline, "cid", 0)
	if _, err := Reclaim(s, asker1, creator1, deadline+ReclaimGrace, 1); err == nil || askErrSymbol(err) != ErrState {
		t.Fatalf("reclaim at deadline+grace (boundary): err=%v, want ErrState", err)
	}

	// One block later: open.
	mkPendingEscrow(s, creator1, 2, asker1, 42, deadline, "cid", 0)
	if _, err := Reclaim(s, asker1, creator1, deadline+ReclaimGrace+1, 2); err != nil {
		t.Fatalf("reclaim at deadline+grace+1 should succeed: %v", err)
	}

	if bal := getMoney(s, kBal(creator1, asker1)); bal.Cmp(big.NewInt(42)) != 0 {
		t.Fatalf("only the legal reclaim should have paid out: balance = %s, want 42", bal)
	}
}

// TestReclaimNoCommissionCharged proves invariant I5 using a REAL Ask(),
// not a synthetically-built escrow record. The previous version of this
// test built its escrow directly via mkPendingEscrow and only proved
// Reclaim doesn't ADD a treasury debit — it never proved a real Ask()'s
// commission actually comes back, which is the whole point of the defect
// fix. This version seeds the treasury from an UNRELATED prior Ask+Answer
// (a real, legitimately-booked commission — asker2's ask gets answered) so
// the test proves Reclaim leaves EXISTING treasury funds untouched, not
// just "starts and stays at zero", and separately proves this escrow's own
// held commission is returned via ReclaimResult.CommissionHbd, not
// forfeited.
func TestReclaimNoCommissionCharged(t *testing.T) {
	s := NewMemStore()
	// RULING C fixture: canonical S=100 / rate 400 market — 3 credits per
	// 1000-face ask.
	curveMarket(s, creator1, 100)
	setMoney(s, kFace(creator1), big.NewInt(1000))
	setMoney(s, kBal(creator1, asker1), big.NewInt(5000))
	setMoney(s, kBal(creator1, asker2), big.NewInt(5000))
	block := seedSettleObs(s, creator1, 1000, big.NewInt(400))
	activateMarket(s, creator1, block)

	commission := commissionOwedFor(big.NewInt(1000))
	maxCredits := big.NewInt(3)

	seedRes, err := askAt0(s, asker2, creator1, block, maxCredits, commission, "seed-cid", MinAskDeadline)
	if err != nil {
		t.Fatalf("seed Ask: %v", err)
	}
	if _, err := Answer(s, creator1, creator1, block+1, seedRes.Seq, "seed-ans"); err != nil {
		t.Fatalf("seed Answer: %v", err)
	}
	treasuryAfterSeed := getMoney(s, kTreasury())
	if treasuryAfterSeed.Cmp(commission) != 0 {
		t.Fatalf("sanity: treasury after seed = %s, want %s", treasuryAfterSeed, commission)
	}

	// This test's OWN ask, which will be reclaimed unanswered.
	askRes, err := askAt0(s, asker1, creator1, block, maxCredits, commission, "cid", MinAskDeadline)
	if err != nil {
		t.Fatalf("Ask: %v", err)
	}

	reclaimBlock := block + MinAskDeadline + ReclaimGrace + 1
	res, err := Reclaim(s, asker1, creator1, reclaimBlock, askRes.Seq)
	if err != nil {
		t.Fatalf("Reclaim: %v", err)
	}
	if res.CreditsReturned.Cmp(big.NewInt(3)) != 0 {
		t.Fatalf("reclaimed %s, want the full 3 (no commission deducted)", res.CreditsReturned)
	}
	if res.CommissionHbd.Cmp(commission) != 0 {
		t.Fatalf("CommissionHbd returned = %s, want the FULL %s back (SPEC §1.7.2 rule 4)", res.CommissionHbd, commission)
	}
	if treas := getMoney(s, kTreasury()); treas.Cmp(treasuryAfterSeed) != 0 {
		t.Fatalf("treasury = %s, want unchanged %s (no commission on reclaim, I5)", treas, treasuryAfterSeed)
	}
}

// TestReclaimReturnsCommissionInFull is the direct round-trip proof for
// DEFECT 1: a real Ask() followed by a real Reclaim() must return the
// asker's credits AND the full commission, with the asker's balance
// restored to exactly what it was before the ask.
func TestReclaimReturnsCommissionInFull(t *testing.T) {
	s := NewMemStore()
	// RULING C fixture: canonical S=100 / rate 400 market — 3 credits per
	// 1000-face ask.
	curveMarket(s, creator1, 100)
	setMoney(s, kFace(creator1), big.NewInt(1000))
	setMoney(s, kBal(creator1, asker1), big.NewInt(5000))
	block := seedSettleObs(s, creator1, 1000, big.NewInt(400))
	activateMarket(s, creator1, block)

	commission := commissionOwedFor(big.NewInt(1000)) // 120
	maxCredits := big.NewInt(3)

	askRes, err := askAt0(s, asker1, creator1, block, maxCredits, commission, "cid", MinAskDeadline)
	if err != nil {
		t.Fatalf("Ask: %v", err)
	}
	if got := getMoney(s, kBal(creator1, asker1)); got.Cmp(big.NewInt(4997)) != 0 {
		t.Fatalf("asker balance after Ask = %s, want 4997 (5000-3 credits spent)", got)
	}

	treasuryBefore := getMoney(s, kTreasury())

	reclaimBlock := block + MinAskDeadline + ReclaimGrace + 1
	res, err := Reclaim(s, asker1, creator1, reclaimBlock, askRes.Seq)
	if err != nil {
		t.Fatalf("Reclaim: %v", err)
	}
	if res.CreditsReturned.Cmp(big.NewInt(3)) != 0 {
		t.Fatalf("CreditsReturned = %s, want 3 (100%% of credits back, I5)", res.CreditsReturned)
	}
	if res.CommissionHbd.Cmp(commission) != 0 {
		t.Fatalf("CommissionHbd = %s, want %s (the FULL 12%% commission back — DEFECT 1, SPEC §1.7.2 rule 4: 'No commission on refunds')", res.CommissionHbd, commission)
	}
	if got := getMoney(s, kBal(creator1, asker1)); got.Cmp(big.NewInt(5000)) != 0 {
		t.Fatalf("asker balance after Reclaim = %s, want 5000 (fully restored)", got)
	}
	if got := getMoney(s, kTreasury()); got.Cmp(treasuryBefore) != 0 {
		t.Fatalf("treasury moved on Reclaim: %s -> %s (I5 violated)", treasuryBefore, got)
	}
}

// TestReclaimWorksWhenFrozenAndClosed proves Reclaim consults no phase
// state at all (API.md rule 4, SPEC §1.7.2 guardrail #1: "non-payment must
// never touch funds"). Escrows are built directly, independent of
// Ask()/RequireInflowOpen.
func TestReclaimWorksWhenFrozenAndClosed(t *testing.T) {
	const deadline = uint64(500)
	block := deadline + ReclaimGrace + 1

	for _, phase := range []string{StateFrozen, StateClosed} {
		s := NewMemStore()
		setU64(s, kPaidUntil(creator1), 1)
		setStr(s, kState(creator1), phase)
		mkPendingEscrow(s, creator1, 0, asker1, 42, deadline, "cid", 0)

		got, err := Reclaim(s, asker1, creator1, block, 0)
		if err != nil {
			t.Fatalf("[%s] Reclaim must succeed regardless of phase, got: %v", phase, err)
		}
		if got.CreditsReturned.Cmp(big.NewInt(42)) != 0 {
			t.Fatalf("[%s] reclaimed = %s, want 42", phase, got.CreditsReturned)
		}
	}
}

// ---- I6: the disjoint-window proof --------------------------------------

// TestAnswerReclaimWindowsDisjoint is the core proof of invariant I6. On
// Magi, transaction order inside a single VSC block is chosen unilaterally
// by the block producer and is NOT consensus-enforced (the verified
// producer-ordering defect this whole escrow shape exists to neutralize).
// So the only way to make ordering irrelevant is for the answer and reclaim
// windows to never both be legal in the same block, for ANY block.
//
// For every block from deadline-5 through deadline+ReclaimGrace+5, this
// tries BOTH orderings (Answer-then-Reclaim and Reclaim-then-Answer) on
// fresh, identical escrows, and asserts:
//  1. never both succeed, in either ordering;
//  2. the outcome (which one succeeds, if either) is identical regardless
//     of which is attempted first — order-independence, the actual point;
//  3. in the strict gap (deadline, deadline+ReclaimGrace], NEITHER succeeds
//     in either ordering — this is what makes (1) and (2) true by
//     construction rather than by accident of which check happens to run
//     first.
func TestAnswerReclaimWindowsDisjoint(t *testing.T) {
	const deadline = uint64(100_000)
	const credits = int64(42)

	fresh := func() (Store, uint64) {
		s := NewMemStore()
		const seq = uint64(0)
		mkPendingEscrow(s, creator1, seq, asker1, credits, deadline, "cid", 0)
		return s, seq
	}

	lo := deadline - 5
	hi := deadline + ReclaimGrace + 5

	for b := lo; b <= hi; b++ {
		// Ordering 1: Answer attempted first, then Reclaim.
		s1, seq1 := fresh()
		_, errA1 := Answer(s1, creator1, creator1, b, seq1, "ans")
		_, errR1 := Reclaim(s1, asker1, creator1, b, seq1)
		succA1, succR1 := errA1 == nil, errR1 == nil

		// Ordering 2: Reclaim attempted first, then Answer.
		s2, seq2 := fresh()
		_, errR2 := Reclaim(s2, asker1, creator1, b, seq2)
		_, errA2 := Answer(s2, creator1, creator1, b, seq2, "ans")
		succA2, succR2 := errA2 == nil, errR2 == nil

		if succA1 && succR1 {
			t.Fatalf("block %d: BOTH answer and reclaim succeeded (order answer-then-reclaim)", b)
		}
		if succA2 && succR2 {
			t.Fatalf("block %d: BOTH answer and reclaim succeeded (order reclaim-then-answer)", b)
		}
		if succA1 != succA2 || succR1 != succR2 {
			t.Fatalf("block %d: outcome depends on call order: order1(answer=%v,reclaim=%v) order2(answer=%v,reclaim=%v)",
				b, succA1, succR1, succA2, succR2)
		}

		switch {
		case b <= deadline:
			if !succA1 || succR1 || succR2 {
				t.Fatalf("block %d (<=deadline): want answer-only, got order1(answer=%v,reclaim=%v) order2(answer=%v,reclaim=%v)",
					b, succA1, succR1, succA2, succR2)
			}
		case b > deadline+ReclaimGrace:
			if !succR1 || succA1 || succA2 {
				t.Fatalf("block %d (>deadline+grace): want reclaim-only, got order1(answer=%v,reclaim=%v) order2(answer=%v,reclaim=%v)",
					b, succA1, succR1, succA2, succR2)
			}
		default: // strict gap: deadline < b <= deadline+ReclaimGrace
			if succA1 || succR1 || succA2 || succR2 {
				t.Fatalf("block %d (gap): want NEITHER to succeed, got order1(answer=%v,reclaim=%v) order2(answer=%v,reclaim=%v)",
					b, succA1, succR1, succA2, succR2)
			}
		}
	}
}
