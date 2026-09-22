package core

import (
	"math/big"
	"reflect"
	"strings"
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
// platform1 is the account the wasm `init` entrypoint binds as the contract
// owner (core/keys.go's kOwner()). It matters to every escrow test since the
// OWNER RULING of 2026-09-12: the 12% commission is credited to THIS account's
// token position on the creator's own market when an ask is answered, and the
// miss slice of it when an ask is reclaimed. With no owner bound, core pays the
// whole escrow to the creator instead — a deliberate, tested fallback (see
// TestAnswer_NoOwnerBoundPaysTheWholeEscrowToTheCreator) but not the shape most
// of these tests are about.
const platform1 = "platform1"

// bindOwner does what `init` does, and nothing else.
func bindOwner(s Store) { setStr(s, kOwner(), platform1) }

// commissionMarket builds a market big enough for the platform's 12%% to be a
// non-zero whole number of credits, and returns the block asks may be placed at.
//
// ★ WHY IT HAS TO EXIST (OWNER RULING 2026-09-12). The commission is now
// floor(credits * CommissionBps / 10000), so it is ZERO until an ask costs at
// least ceil(10000/1200) = 9 credits — and the canonical S=100/rate=400 fixture
// the escrow suite was built on settles at 3. Every commission assertion written
// against that fixture would pass while asserting nothing, which is the vacuous
// -pass failure mode this codebase treats as worse than a red test. This fixture
// settles at 50 credits (commission 6, miss slice 2), comfortably clear of every
// settlement guard: C4 needs rate <= 2*face, C2 needs face <= 50%% of area(2000),
// and the spend cap allows 5%% of supply = 100 credits.
func commissionMarket(t *testing.T, s Store, creator string, askers ...string) (block uint64, face *big.Int) {
	t.Helper()
	face = big.NewInt(200_000)
	curveMarket(s, creator, 2000)
	setMoney(s, kFace(creator), face)
	for _, a := range askers {
		setMoney(s, kBal(creator, a), tk(5_000_000))
	}
	block = seedSettleObs(s, creator, 1000, big.NewInt(4000))
	activateMarket(s, creator, block)
	return block, face
}

func curveMarket(s Store, creator string, supply int64) {
	// supply is WHOLE tokens; state holds units (v6).
	setMoney(s, kSupply(creator), tk(supply))
	setMoney(s, kReserve(creator), Area(tk(supply)))
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
		asker:             asker,
		credits:           tk(credits), // tokens in the fixture, units in state (v6)
		deadline:          deadline,
		status:            askPending,
		contentHash:       contentHash,
		answerHash:        "",
		commissionCredits: tk(commissionHbd),
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
	setMoney(s, kBal(creator1, asker1), tk(5000))
	block := seedSettleObs(s, creator1, 1000, big.NewInt(400))
	activateMarket(s, creator1, block)

	maxCredits := tk(3)
	commission := commissionOwedFor(big.NewInt(1000))
	if commission.Cmp(big.NewInt(120)) != 0 {
		t.Fatalf("sanity: commission = %s, want 120 (12%% of 1000)", commission)
	}

	res, err := askAt0(s, asker1, creator1, block, maxCredits, "cid-1", MinAskDeadline)
	if err != nil {
		t.Fatalf("Ask: %v", err)
	}
	if res.Seq != 0 {
		t.Fatalf("Seq = %d, want 0", res.Seq)
	}
	// v6: 1000/400 = 2.50 tokens exactly = 250 units (no whole-token ceil to 3).
	if res.CreditsSpent.Cmp(big.NewInt(250)) != 0 {
		t.Fatalf("CreditsSpent = %s, want 250 units (ceil(1000*100/400))", res.CreditsSpent)
	}
	// The commission is a carve out of those very credits (OWNER RULING
	// 2026-09-12), not a second amount: 12% of 3 floors to 0 here, and the
	// creator takes the whole escrow. That zero is not a gap — it is the
	// floor rounding in the creator's favour, exactly as every other rounding
	// on this path does; the platform only starts earning once an ask costs
	// enough credits for 12% of them to be a whole token. See
	// TestAsk_CommissionFloorsToZeroOnTinyAsks below, which pins the boundary.
	if got := commissionOwedFor(res.CreditsSpent); res.CommissionCredits.Cmp(got) != 0 {
		t.Fatalf("CommissionCredits = %s, want commissionOwedFor(%s) = %s", res.CommissionCredits, res.CreditsSpent, got)
	}
	if res.RateUsed.Cmp(big.NewInt(400)) != 0 {
		t.Fatalf("RateUsed = %s, want 400 (the seeded settlement rate)", res.RateUsed)
	}

	if got := getMoney(s, kBal(creator1, asker1)); got.Cmp(new(big.Int).Sub(tk(5000), big.NewInt(250))) != 0 {
		t.Fatalf("asker balance = %s, want 5000 tokens less the 250-unit spend", got)
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
	if rec.credits.Cmp(big.NewInt(250)) != 0 { // v6: 1000/400 = 2.50 tokens = 250 units
		t.Fatalf("escrow.credits = %s, want 250", rec.credits)
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
	if want := commissionOwedFor(rec.credits); rec.commissionCredits.Cmp(want) != 0 {
		t.Fatalf("escrow.commissionCredits = %s, want %s (held for Answer/Reclaim)", rec.commissionCredits, want)
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
	_, err := askAt0(s, asker1, creator1, 1000, tk(0), "cid", MinAskDeadline)
	if err == nil {
		t.Fatal("expected error for maxCredits=0")
	}
	if askErrSymbol(err) != ErrInput {
		t.Fatalf("symbol = %q, want %q (err=%v)", askErrSymbol(err), ErrInput, err)
	}

	_, err = askAt0(s, asker1, creator1, 1000, nil, "cid", MinAskDeadline)
	if err == nil {
		t.Fatal("expected error for maxCredits=nil")
	}
	if askErrSymbol(err) != ErrInput {
		t.Fatalf("symbol = %q, want %q (err=%v)", askErrSymbol(err), ErrInput, err)
	}

	_, err = askAt0(s, asker1, creator1, 1000, big.NewInt(-5), "cid", MinAskDeadline)
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
	setMoney(s, kBal(creator1, asker1), tk(1_000_000))
	block := seedSettleObs(s, creator1, 1000, big.NewInt(500))
	activateMarket(s, creator1, block)

	// The asker quotes at face=1000, rate=500: creditsForAsk = 2, and
	// signs maxCredits=2 — willing to pay AT MOST what they quoted.
	maxCredits := tk(2)

	// ATTACK: the creator sneaks a face change into the same block, before
	// the asker's already-signed ask executes — no different in kind from a
	// real SetFace call landing first under producer-chosen ordering.
	// 4000 at rate 500 -> ceil = 8 credits, over the signed cap of 2.
	setMoney(s, kFace(creator1), big.NewInt(4000)) // 4x spike

	_, err := askAt0(s, asker1, creator1, block, maxCredits, "cid", MinAskDeadline)
	if err == nil {
		t.Fatal("expected the spiked-face ask to revert, not silently spend more credits")
	}
	if askErrSymbol(err) != ErrInput {
		t.Fatalf("symbol = %q, want %q (err=%v)", askErrSymbol(err), ErrInput, err)
	}
	// Total no-op: nothing moved.
	if got := getMoney(s, kBal(creator1, asker1)); got.Cmp(tk(1_000_000)) != 0 {
		t.Fatalf("asker balance changed on reverted ask: %s", got)
	}
	if got := getU64(s, kSeq(creator1)); got != 0 {
		t.Fatalf("kSeq advanced on reverted ask: %d", got)
	}

	// A legitimate ask at EXACTLY maxCredits (face restored to what the
	// asker actually quoted) must still succeed — the guard must not be
	// off-by-one.
	setMoney(s, kFace(creator1), big.NewInt(1000))
	res, err := askAt0(s, asker1, creator1, block, maxCredits, "cid", MinAskDeadline)
	if err != nil {
		t.Fatalf("ask at exactly maxCredits should succeed: %v", err)
	}
	if res.CreditsSpent.Cmp(maxCredits) != 0 {
		t.Fatalf("CreditsSpent = %s, want exactly maxCredits %s", res.CreditsSpent, maxCredits)
	}
}

// ★ THE TWO H2 COMMISSION-AMOUNT TESTS THAT USED TO LIVE HERE ARE GONE, AND
// THIS REPLACES THEM (OWNER RULING 2026-09-12).
//
// TestAskCommissionUnderpaidRejected and TestAskCommissionOverpaidRejected
// pinned the H2 defect fix (2026-07-21): core.Ask took a commissionHbdPaid
// argument — HBD the wrapper had already drawn from the buyer — and required it
// to EXACTLY equal commissionOwedFor(face) at execution, refusing both an
// underpayment and (the actual defect) an overpayment, which the old >= bound
// had accepted, held in full and booked to a treasury with no exit.
//
// THE PARAMETER NO LONGER EXISTS. The commission is carved out of the CREDITS
// inside the escrow, so there is no second amount for a caller to get wrong and
// no sandwich window between two legs. What has to be proven instead is that the
// carve is derived from the SAME quote the credits came from and is a partition
// of them — which is what this test does. The H2 attack itself (a band-legal
// SetFace between signing and execution) is still covered, by
// TestAskMaxCreditsSlippageGuard above: maxCredits now bounds the whole price.
func TestAskCommissionIsCarvedFromCreditsNotChargedOnTop(t *testing.T) {
	s := NewMemStore()
	// The canonical S=100 / rate 400 fixture (TestAskHappyPath has the math).
	curveMarket(s, creator1, 100)
	setMoney(s, kFace(creator1), big.NewInt(1000))
	setMoney(s, kBal(creator1, asker1), tk(5000))
	block := seedSettleObs(s, creator1, 1000, big.NewInt(400))
	activateMarket(s, creator1, block)

	balBefore := getMoney(s, kBal(creator1, asker1))
	res, err := askAt0(s, asker1, creator1, block, tk(10), "cid", MinAskDeadline)
	if err != nil {
		t.Fatalf("ask: %v", err)
	}

	// 1. The commission is exactly the ruled fraction OF THE CREDITS.
	wantCommission := commissionOwedFor(res.CreditsSpent)
	if res.CommissionCredits.Cmp(wantCommission) != 0 {
		t.Fatalf("CommissionCredits = %s, want %s = floor(%s * %d / 10000)",
			res.CommissionCredits, wantCommission, res.CreditsSpent, CommissionBps)
	}

	// 2. It is a PARTITION, not a surcharge: the asker is debited CreditsSpent
	//    and not one unit more. This is the property the ruling exists for — a
	//    buyer holding only tokens can buy a service.
	wantBal := new(big.Int).Sub(balBefore, res.CreditsSpent)
	if got := getMoney(s, kBal(creator1, asker1)); got.Cmp(wantBal) != 0 {
		t.Fatalf("asker balance = %s, want %s (debited exactly CreditsSpent %s)", got, wantBal, res.CreditsSpent)
	}

	// 3. NO HBD moved anywhere. The treasury is the only HBD bucket an ask could
	//    ever have touched, and it must be untouched now.
	if got := getMoney(s, kTreasury()); got.Sign() != 0 {
		t.Fatalf("treasury moved on an ask: %s — an ask must move no HBD at all", got)
	}

	// 4. The escrow RECORDS the commission rather than leaving it to be
	//    recomputed at settlement (see escrowRec's doc).
	rec, ok := loadEscrow(s, creator1, res.Seq)
	if !ok {
		t.Fatal("escrow record missing")
	}
	if rec.commissionCredits.Cmp(wantCommission) != 0 {
		t.Fatalf("escrow commissionCredits = %s, want %s", rec.commissionCredits, wantCommission)
	}
	if rec.credits.Cmp(res.CreditsSpent) != 0 {
		t.Fatalf("escrow credits = %s, want the whole spend %s", rec.credits, res.CreditsSpent)
	}
	// 5. And the commission can never exceed what is there to pay it from.
	if rec.commissionCredits.Cmp(rec.credits) > 0 {
		t.Fatalf("commission %s exceeds the escrow %s it is carved from", rec.commissionCredits, rec.credits)
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
		// v6: credits are UNITS, ceil(face x TokenScale / rate).
		q.QuoRem(new(big.Int).Mul(face, unitsScale), rate, r) // floor division for non-negative operands
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
	setMoney(s, kSupply(creator1), tk(250))
	setMoney(s, kFace(creator1), big.NewInt(101))
	setMoney(s, kBal(creator1, asker1), tk(1_000_000))

	askBlock := seedSettleObs(s, creator1, 1000, big.NewInt(10))
	activateMarket(s, creator1, askBlock)

	res, err := askAt0(s, asker1, creator1, askBlock, tk(20), "cid", MinAskDeadline)
	if err != nil {
		t.Fatalf("Ask: %v", err)
	}
	if res.RateUsed.Cmp(big.NewInt(10)) != 0 {
		t.Fatalf("RateUsed = %s, want 10 (the seeded TWAP)", res.RateUsed)
	}
	// ★ THE WHOLE POSTED FACE IS PRICED (OWNER RULING 2026-09-12): ceil(101/10)
	// = 11 credits, where floor would give 10. Between 2026-07-27 and that
	// ruling only an 89-token leg was priced (9 credits) and the remaining 12%%
	// was drawn separately in HBD; the ceiling wiring this test exists for is
	// the same either way, and 101/10 exercises it with a real remainder.
	// v6: 101/10 = 10.1 tokens exactly = 1010 units; the whole-token ceil to 11 is gone.
	if res.CreditsSpent.Cmp(big.NewInt(1010)) != 0 {
		t.Fatalf("CreditsSpent = %s, want 1010 units (ceil(101*100/10))", res.CreditsSpent)
	}
	if got := getMoney(s, kBal(creator1, asker1)); got.Cmp(new(big.Int).Sub(tk(1_000_000), big.NewInt(1010))) != 0 {
		t.Fatalf("asker balance = %s, want %d", got, 1_000_000-11)
	}
	// The two legs re-sum to the credits taken, exactly: floor for the platform,
	// remainder for the creator.
	toCreator := new(big.Int).Sub(res.CreditsSpent, res.CommissionCredits)
	if sum := new(big.Int).Add(toCreator, res.CommissionCredits); sum.Cmp(res.CreditsSpent) != 0 {
		t.Fatalf("legs = %s, want the %s credits taken", sum, res.CreditsSpent)
	}
}

// TestAsk_PostedFaceIsTheBuyersTotal pins USER RULING 2026-07-27: the price a
// creator posts is the TOTAL the buyer parts with, never a base the platform's
// 12% is added on top of. The 2026-09-12 OWNER RULING kept that guarantee and
// changed how it is delivered — the buyer now pays the whole posted price in
// ONE asset and the commission is carved out of those tokens — so this test
// asserts the same promise against the new mechanism.
//
// The regression it guards is the one that shipped: settling the token leg at
// the FULL posted face while ALSO drawing 12% on top, so a creator's "9090"
// service cost the buyer 9090 in tokens PLUS 1090 in HBD — a 12% surcharge
// disclosed nowhere, in no quote, on no screen. Under the new model that
// surcharge is structurally impossible (there is no second leg to draw), and
// what has to be proven instead is that the SINGLE debit equals the posted
// price at the settlement rate, and that the commission comes out of it.
func TestAsk_PostedFaceIsTheBuyersTotal(t *testing.T) {
	s := NewMemStore()
	curveMarket(s, creator1, 1000)
	const posted = int64(9090)
	setMoney(s, kFace(creator1), big.NewInt(posted))
	setMoney(s, kBal(creator1, asker1), tk(50_000))
	askBlock := seedSettleObs(s, creator1, 1000, big.NewInt(2000))
	activateMarket(s, creator1, askBlock)

	balBefore := getMoney(s, kBal(creator1, asker1))
	res, err := askAt0(s, asker1, creator1, askBlock, tk(10), "cid", MinAskDeadline)
	if err != nil {
		t.Fatalf("Ask: %v", err)
	}
	// ceil(9090/2000) = 5 credits — the WHOLE posted price, priced once.
	// v6: 9090/2000 = 4.545 tokens -> 455 units (4.55), not the whole-token ceil to 5.
	if res.CreditsSpent.Cmp(big.NewInt(455)) != 0 {
		t.Fatalf("CreditsSpent = %s, want 455 units (ceil(9090*100/2000) — the whole posted face)", res.CreditsSpent)
	}
	// THE BUYER PARTED WITH EXACTLY THAT AND NOTHING ELSE. This is the
	// surcharge check in its new form: one asset, one debit.
	wantBal := new(big.Int).Sub(balBefore, res.CreditsSpent)
	if got := getMoney(s, kBal(creator1, asker1)); got.Cmp(wantBal) != 0 {
		t.Fatalf("asker balance = %s, want %s — a second leg is being charged somewhere", got, wantBal)
	}
	if got := getMoney(s, kTreasury()); got.Sign() != 0 {
		t.Fatalf("treasury = %s, want 0 — no HBD leg may exist on this path", got)
	}
	// And the commission is INSIDE that debit: floor for the platform,
	// remainder for the creator, summing to exactly what was taken.
	wantCommission := commissionOwedFor(res.CreditsSpent)
	if res.CommissionCredits.Cmp(wantCommission) != 0 {
		t.Fatalf("CommissionCredits = %s, want %s = floor(%s * %d / 10000)", res.CommissionCredits, wantCommission, res.CreditsSpent, CommissionBps)
	}
	if res.CommissionCredits.Cmp(res.CreditsSpent) > 0 {
		t.Fatalf("commission %s exceeds the %s credits it is carved from", res.CommissionCredits, res.CreditsSpent)
	}
}

// TestAsk_CommissionFloorsToZeroOnTinyAsks pins the HONEST PRODUCT LIMIT of the
// 2026-09-12 ruling, so nobody has to rediscover it from a revenue report.
//
// The commission is floor(credits * 1200 / 10000), so it is ZERO for any ask
// costing 8 credits or fewer and only becomes non-zero at 9. That is the same
// direction every other rounding on this path takes — in the creator's favour,
// never the buyer's — but it has a real consequence: a service priced at fewer
// than ~9 tokens earns the platform nothing, and because the token price grows
// quadratically with supply while a posted face is capped by MaxFace, the
// credits an ask costs FALL as a market succeeds. A mature market therefore pays
// less commission per ask, not more.
//
// The lever, if that is ever judged wrong, is sub-token settlement granularity
// (which settlement.go's C4 doc already names as the structural cure for the
// same class of problem) — never a ceil here, which would charge a 1-credit ask
// 100%% commission.
func TestAsk_CommissionFloorsToZeroOnTinyAsks(t *testing.T) {
	for credits, want := range map[int64]int64{1: 0, 8: 0, 9: 1, 50: 6, 100: 12} {
		got := commissionOwedFor(big.NewInt(credits))
		if got.Cmp(big.NewInt(want)) != 0 {
			t.Fatalf("commissionOwedFor(%d credits) = %s, want %d", credits, got, want)
		}
	}
}

func TestAskDeadlineOutOfBandRejected(t *testing.T) {
	s := NewMemStore()
	// No market setup needed: the deadline-band guard fires before
	// RequireInflowOpen.
	_, err := askAt0(s, asker1, creator1, 1000, tk(1), "cid", MinAskDeadline-1)
	if err == nil || askErrSymbol(err) != ErrInput {
		t.Fatalf("below MinAskDeadline: err=%v, want ErrInput", err)
	}
	_, err = askAt0(s, asker1, creator1, 1000, tk(1), "cid", MaxAskDeadline+1)
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
	// s, caller, creator, block, maxCredits, contentHash, deadlineBlocks,
	// offeringID (2026-07-27 — which named service this ask buys; 0 == the
	// legacy `face` price). The commissionHbdPaid parameter was removed on
	// 2026-09-12 with the HBD leg itself. Still no `rate`: the settlement rate
	// remains derived inside core, never caller-supplied, which is the property
	// this test exists to pin.
	const wantParams = 8
	if fn.NumIn() != wantParams {
		t.Fatalf("core.Ask has %d parameters, want %d — signature shape changed; re-verify no `rate` parameter was reintroduced", fn.NumIn(), wantParams)
	}
	bigIntParams := 0
	for i := 0; i < fn.NumIn(); i++ {
		if fn.In(i).String() == "*big.Int" {
			bigIntParams++
		}
	}
	// Exactly ONE *big.Int parameter: maxCredits, the asker's own slippage cap.
	// commissionHbdPaid was the second until 2026-09-12, when the HBD leg was
	// removed. A SECOND one now would mean a caller-suppliable `rate` crept back
	// in, silently defeating SPEC §1.3b's TWAP defense.
	if bigIntParams != 1 {
		t.Fatalf("core.Ask has %d *big.Int parameters, want exactly 1 (maxCredits) — a second suggests a caller-suppliable `rate` was reintroduced", bigIntParams)
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

func TestSettlementRate_CurvePricesWithNoHistory(t *testing.T) {
	// ★ INVERTED 2026-09-16 (owner ruling: no trading-history gate). This used
	// to assert an ErrOracle refusal on a market with no observations; the
	// PAR fallback this guarded against (1 base unit per token, a 100x
	// overcharge) is still gone — the fallback is SPOT, the no-arbitrage
	// ceiling, never PAR.
	s := NewMemStore()
	curveMarket(s, creator1, 100)
	got, err := SettlementRate(s, creator1, 1000)
	if err != nil {
		t.Fatalf("SettlementRate refused a market with no observations: %v", err)
	}
	if want := SpotRate(tk(100)); got.Cmp(want) != 0 {
		t.Fatalf("SettlementRate = %s, want spot %s (no window: the curve alone prices)", got, want)
	}
	if got.Cmp(big.NewInt(1)) == 0 {
		t.Fatal("REGRESSION: the PAR fallback is back")
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
func TestAsk_SettlesAtSpotWithNoHistory(t *testing.T) {
	// ★ INVERTED 2026-09-16 (owner ruling): an ask on a market with no
	// trading history settles at the curve's spot price instead of refusing.
	// The downstream checks are inverted with it: the balance MOVES and the
	// sequence ADVANCES, because the ask now exists.
	s := NewMemStore()
	const block = uint64(1000)
	curveMarket(s, creator1, 100)
	activateMarket(s, creator1, block)
	setMoney(s, kFace(creator1), big.NewInt(1000))
	setMoney(s, kBal(creator1, asker1), tk(5000))
	spot := SpotRate(tk(100))
	wantCredits := creditsForAsk(big.NewInt(1000), spot)
	res, err := askAt0(s, asker1, creator1, block, tk(1000), "cid", MinAskDeadline)
	if err != nil {
		t.Fatalf("Ask with no oracle history must settle at spot, got: %v", err)
	}
	if res.RateUsed.Cmp(spot) != 0 {
		t.Fatalf("RateUsed = %s, want spot %s", res.RateUsed, spot)
	}
	if res.CreditsSpent.Cmp(wantCredits) != 0 {
		t.Fatalf("CreditsSpent = %s, want %s", res.CreditsSpent, wantCredits)
	}
	if got := getMoney(s, kBal(creator1, asker1)); got.Cmp(new(big.Int).Sub(tk(5000), wantCredits)) != 0 {
		t.Fatalf("asker balance = %s, want 5000 - %s", got, wantCredits)
	}
	if got := getU64(s, kSeq(creator1)); got != 1 {
		t.Fatalf("kSeq = %d, want 1 (the ask exists)", got)
	}
}

// TestAsk_SettlesAtTWAPWhenAvailable proves Ask() prices off the min() the
// moment a market has enough valid observations in BOTH windows.
func TestAsk_SettlesAtTWAPWhenAvailable(t *testing.T) {
	s := NewMemStore()
	// S=200 so the spot arm (2680) sits ABOVE the seeded 2000 and the min
	// resolves to the TWAP; C4 boundary passes exactly (face·2 == rate).
	curveMarket(s, creator1, 200)
	// POSTED face 1136, not 1000: C4 measures the TOKEN leg after the
	// commission carve-out (USER RULING 2026-07-27), and 1136 is the exact
	// posted price whose leg is 1136-floor(1136*1200/10000) = 1136-136 = 1000,
	// i.e. exactly rate/2 — so this fixture still sits ON the C4 boundary,
	// which is the whole point of it.
	setMoney(s, kFace(creator1), big.NewInt(1136))
	setMoney(s, kBal(creator1, asker1), tk(5000))
	askBlock := seedSettleObs(s, creator1, 1000, big.NewInt(2000))
	activateMarket(s, creator1, askBlock)

	wantCredits := creditsForAsk(big.NewInt(1136), big.NewInt(2000)) // the posted face over the TWAP: ceil(1136*100/2000) = 57 units

	res, err := askAt0(s, asker1, creator1, askBlock, wantCredits, "cid", MinAskDeadline)
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
	bindOwner(s)
	const deadline = uint64(500)
	mkPendingEscrow(s, creator1, 0, asker1, 42, deadline, "cid", 5)

	res, err := Answer(s, creator1, creator1, 400, 0, "answer-hash")
	if err != nil {
		t.Fatalf("Answer: %v", err)
	}
	// ★ THE ESCROW SPLITS TWO WAYS (OWNER RULING 2026-09-12): 42 credits escrowed,
	// 5 of them the platform's, so the creator receives 37 and the owner 5 — in
	// TOKENS, on this market, not HBD into the treasury.
	if res.CreditsToCreator.Cmp(tk(37)) != 0 {
		t.Fatalf("CreditsToCreator = %s, want 37 (42 escrowed − 5 commission)", res.CreditsToCreator)
	}
	if res.CommissionToOwner.Cmp(tk(5)) != 0 {
		t.Fatalf("CommissionToOwner = %s, want 5", res.CommissionToOwner)
	}
	if res.Owner != platform1 {
		t.Fatalf("Owner = %q, want %q (who was actually credited)", res.Owner, platform1)
	}
	if got := totalBalance(s, creator1, creator1); got.Cmp(tk(37)) != 0 {
		t.Fatalf("creator balance = %s, want 37", got)
	}
	if got := totalBalance(s, creator1, platform1); got.Cmp(tk(5)) != 0 {
		t.Fatalf("owner balance = %s, want 5 (the commission, in tokens)", got)
	}
	if got := getMoney(s, kTreasury()); got.Sign() != 0 {
		t.Fatalf("treasury = %s, want 0 — Answer must move no HBD at all", got)
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
	setStr(s, kState(creator1), StateFrozen)
	mkPendingEscrow(s, creator1, 0, asker1, 42, deadline, "cid", 0)

	res, err := Answer(s, creator1, creator1, 400, 0, "answer-hash")
	if err != nil {
		t.Fatalf("Answer while FROZEN must succeed, got: %v", err)
	}
	if res.CreditsToCreator.Cmp(tk(42)) != 0 {
		t.Fatalf("CreditsToCreator = %s, want 42", res.CreditsToCreator)
	}
}

// TestAnswerBooksCommissionExactlyOnce drives a REAL Ask (not a synthetic
// escrow) through Answer and proves the commission moves to the treasury
// exactly once: not at Ask time (defect fix), exactly once at Answer time,
// and never again on a rejected double-answer.
func TestAnswerBooksCommissionExactlyOnce(t *testing.T) {
	s := NewMemStore()
	bindOwner(s)
	// The commission fixture, not the canonical one: 12%% of 3 credits is zero and
	// this test would assert nothing (see commissionMarket's doc).
	block, _ := commissionMarket(t, s, creator1, asker1)
	maxCredits := tk(100)

	askRes, err := askAt0(s, asker1, creator1, block, maxCredits, "cid", MinAskDeadline)
	if err != nil {
		t.Fatalf("Ask: %v", err)
	}
	commission := askRes.CommissionCredits
	if commission.Sign() <= 0 {
		t.Fatalf("fixture must produce a NON-ZERO commission or this test is vacuous (credits=%s)", askRes.CreditsSpent)
	}
	if got := totalBalance(s, creator1, platform1); got.Sign() != 0 {
		t.Fatalf("owner position after Ask = %s, want 0 (commission HELD in escrow, not paid yet)", got)
	}

	answerRes, err := Answer(s, creator1, creator1, block+10, askRes.Seq, "ans")
	if err != nil {
		t.Fatalf("Answer: %v", err)
	}
	if got := totalBalance(s, creator1, platform1); got.Cmp(commission) != 0 {
		t.Fatalf("owner position after Answer = %s, want exactly %s (commission paid on delivery)", got, commission)
	}
	if answerRes.CommissionToOwner.Cmp(commission) != 0 {
		t.Fatalf("AnswerResult.CommissionToOwner = %s, want exactly %s (what was actually credited)", answerRes.CommissionToOwner, commission)
	}

	// Double-answer must be rejected AND must not double-pay.
	_, err = Answer(s, creator1, creator1, block+11, askRes.Seq, "ans2")
	if err == nil || askErrSymbol(err) != ErrState {
		t.Fatalf("double answer: err=%v, want ErrState", err)
	}
	if got := totalBalance(s, creator1, platform1); got.Cmp(commission) != 0 {
		t.Fatalf("owner position after double-answer attempt = %s, want still exactly %s (paid exactly once)", got, commission)
	}
	if got := getMoney(s, kTreasury()); got.Sign() != 0 {
		t.Fatalf("treasury = %s, want 0 — no HBD moves on this rail at all", got)
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
	if got.CreditsReturned.Cmp(tk(42)) != 0 {
		t.Fatalf("reclaimed = %s, want 42 (full amount)", got.CreditsReturned)
	}
	if bal := getMoney(s, kBal(creator1, asker1)); bal.Cmp(tk(42)) != 0 {
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
	bindOwner(s)
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
	// 42 escrowed with a 7-credit commission; the 25%% miss slice rounds UP to 2,
	// so 40 go back to the asker and 2 to the platform owner (OWNER RULING
	// 2026-09-12 — the slice is tokens now, out of the same escrow).
	// v6: the slice is ceil(700 units x 25%) = 175 units (1.75 tokens): the
	// whole-token ceil to 2 is gone, and 175 is above the one-token floor.
	if res.CreditsReturned.Cmp(big.NewInt(4025)) != 0 {
		t.Fatalf("CreditsReturned = %s, want 4025 (4200 escrowed less the 175-unit miss slice)", res.CreditsReturned)
	}
	if res.CommissionRetainedCredits.Cmp(big.NewInt(175)) != 0 {
		t.Fatalf("CommissionRetainedCredits = %s, want 175 (ceil(700*2500/10000))", res.CommissionRetainedCredits)
	}
	if got := totalBalance(s, creator1, platform1); got.Cmp(big.NewInt(175)) != 0 {
		t.Fatalf("owner position = %s, want the 175-unit miss slice", got)
	}

	// The MONEY lands on the asker, never on rando1 (the caller) — this is
	// the load-bearing part of the fix: permissionless does not mean
	// redirectable.
	if bal := getMoney(s, kBal(creator1, asker1)); bal.Cmp(big.NewInt(4025)) != 0 {
		t.Fatalf("asker balance = %s, want 4025 units (the escrow less the miss slice, credited to the ASKER)", bal)
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

	if bal := getMoney(s, kBal(creator1, asker1)); bal.Cmp(tk(42)) != 0 {
		t.Fatalf("only the legal reclaim should have paid out: balance = %s, want 42", bal)
	}
}

// TestReclaimCommissionNetOfMissSlice (was TestReclaimNoCommissionCharged until
// USER RULING 1, 2026-07-28) proves invariant I5 using a REAL Ask(), not a
// synthetically-built escrow record: a real ask's commission really does come
// back, net of the one ruled miss slice.
//
// It seeds the platform owner's position from an UNRELATED prior Ask+Answer (a
// real, legitimately-earned commission — asker2's ask gets answered), so this
// proves the reclaim leaves EXISTING platform earnings untouched and adds
// exactly the slice, rather than the weaker "starts and stays at zero".
//
// ★ SINCE 2026-09-12 EVERY FIGURE HERE IS TOKENS. The commission and its miss
// slice used to be HBD in kTreasury(); they are now credits on the owner's own
// position on this market, and the asker's refund is the escrow MINUS the slice
// rather than the whole escrow plus a separate HBD leg.
func TestReclaimCommissionNetOfMissSlice(t *testing.T) {
	s := NewMemStore()
	bindOwner(s)
	block, _ := commissionMarket(t, s, creator1, asker1, asker2)
	maxCredits := tk(100)

	seedRes, err := askAt0(s, asker2, creator1, block, maxCredits, "seed-cid", MinAskDeadline)
	if err != nil {
		t.Fatalf("seed Ask: %v", err)
	}
	if _, err := Answer(s, creator1, creator1, block+1, seedRes.Seq, "seed-ans"); err != nil {
		t.Fatalf("seed Answer: %v", err)
	}
	ownerAfterSeed := totalBalance(s, creator1, platform1)
	if ownerAfterSeed.Cmp(seedRes.CommissionCredits) != 0 || ownerAfterSeed.Sign() <= 0 {
		t.Fatalf("sanity: owner position after seed = %s, want the non-zero %s", ownerAfterSeed, seedRes.CommissionCredits)
	}
	treasuryAfterSeed := getMoney(s, kTreasury())

	// This test's OWN ask, which will be reclaimed unanswered.
	askRes, err := askAt0(s, asker1, creator1, block, maxCredits, "cid", MinAskDeadline)
	if err != nil {
		t.Fatalf("Ask: %v", err)
	}

	reclaimBlock := block + MinAskDeadline + ReclaimGrace + 1
	res, err := Reclaim(s, asker1, creator1, reclaimBlock, askRes.Seq)
	if err != nil {
		t.Fatalf("Reclaim: %v", err)
	}
	slice := missSliceFor(askRes.CommissionCredits)
	if slice.Sign() <= 0 {
		t.Fatal("fixture must produce a NON-ZERO miss slice or this test is vacuous")
	}
	wantNet := new(big.Int).Sub(askRes.CreditsSpent, slice)
	if res.CreditsReturned.Cmp(wantNet) != 0 {
		t.Fatalf("CreditsReturned = %s, want %s (escrowed %s less the %s miss slice — USER RULING 1)", res.CreditsReturned, wantNet, askRes.CreditsSpent, slice)
	}
	if res.CommissionRetainedCredits.Cmp(slice) != 0 {
		t.Fatalf("CommissionRetainedCredits = %s, want %s", res.CommissionRetainedCredits, slice)
	}
	// The owner's EXISTING earnings are untouched; exactly the slice is added.
	wantOwner := new(big.Int).Add(ownerAfterSeed, slice)
	if got := totalBalance(s, creator1, platform1); got.Cmp(wantOwner) != 0 {
		t.Fatalf("owner position = %s, want %s (the seeded commission untouched, plus exactly the miss slice)", got, wantOwner)
	}
	// And no HBD moved at any point on this rail.
	if treas := getMoney(s, kTreasury()); treas.Cmp(treasuryAfterSeed) != 0 {
		t.Fatalf("treasury moved on an ask/answer/reclaim cycle: %s -> %s", treasuryAfterSeed, treas)
	}
}

// TestReclaimReturnsTheEscrowNetOfTheMissSlice (was
// ...CommissionInFull until USER RULING 1, 2026-07-28, and
// ...CreditsInFullAndCommissionNetOfSlice until the commission became tokens on
// 2026-09-12) is the direct round-trip proof for DEFECT 1: a real Ask() followed
// by a real Reclaim() hands the asker back everything they escrowed except the
// one ruled miss slice, and the slice lands on the platform owner.
//
// ★ THE SHAPE OF THE CLAIM CHANGED WITH THE MONEY. It used to be two statements
// — "the CREDITS come back whole, and the HBD commission comes back net of the
// slice" — because the escrow held two assets. There is one asset now, so it is
// one statement: returned + retained == escrowed, exactly, with the asker's
// token balance restored to (before − slice).
func TestReclaimReturnsTheEscrowNetOfTheMissSlice(t *testing.T) {
	s := NewMemStore()
	bindOwner(s)
	block, _ := commissionMarket(t, s, creator1, asker1)
	maxCredits := tk(100)

	balBefore := getMoney(s, kBal(creator1, asker1))
	askRes, err := askAt0(s, asker1, creator1, block, maxCredits, "cid", MinAskDeadline)
	if err != nil {
		t.Fatalf("Ask: %v", err)
	}
	wantAfterAsk := new(big.Int).Sub(balBefore, askRes.CreditsSpent)
	if got := getMoney(s, kBal(creator1, asker1)); got.Cmp(wantAfterAsk) != 0 {
		t.Fatalf("asker balance after Ask = %s, want %s (debited exactly the %s escrowed)", got, wantAfterAsk, askRes.CreditsSpent)
	}

	treasuryBefore := getMoney(s, kTreasury())
	reclaimBlock := block + MinAskDeadline + ReclaimGrace + 1
	res, err := Reclaim(s, asker1, creator1, reclaimBlock, askRes.Seq)
	if err != nil {
		t.Fatalf("Reclaim: %v", err)
	}

	slice := missSliceFor(askRes.CommissionCredits)
	if slice.Sign() <= 0 {
		t.Fatal("fixture must produce a NON-ZERO miss slice or this test is vacuous")
	}
	// THE SPLIT IS EXHAUSTIVE: every credit escrowed is either returned or
	// retained. A slice that silently exceeded the escrow, or a net that did not
	// account for it, would be tokens appearing or vanishing.
	if sum := new(big.Int).Add(res.CreditsReturned, res.CommissionRetainedCredits); sum.Cmp(askRes.CreditsSpent) != 0 {
		t.Fatalf("returned %s + retained %s = %s, want exactly the escrowed %s",
			res.CreditsReturned, res.CommissionRetainedCredits, sum, askRes.CreditsSpent)
	}
	if res.CommissionRetainedCredits.Cmp(slice) != 0 {
		t.Fatalf("CommissionRetainedCredits = %s, want %s (%d bps of the %s commission)",
			res.CommissionRetainedCredits, slice, MissReclaimSliceBps, askRes.CommissionCredits)
	}
	wantAsker := new(big.Int).Sub(balBefore, slice)
	if got := getMoney(s, kBal(creator1, asker1)); got.Cmp(wantAsker) != 0 {
		t.Fatalf("asker token balance after Reclaim = %s, want %s (restored except the miss slice)", got, wantAsker)
	}
	if got := totalBalance(s, creator1, platform1); got.Cmp(slice) != 0 {
		t.Fatalf("owner position = %s, want exactly the %s miss slice", got, slice)
	}
	if got := getMoney(s, kTreasury()); got.Cmp(treasuryBefore) != 0 {
		t.Fatalf("treasury moved on a reclaim: %s -> %s (no HBD moves on this rail)", treasuryBefore, got)
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
		setStr(s, kState(creator1), phase)
		mkPendingEscrow(s, creator1, 0, asker1, 42, deadline, "cid", 0)

		got, err := Reclaim(s, asker1, creator1, block, 0)
		if err != nil {
			t.Fatalf("[%s] Reclaim must succeed regardless of phase, got: %v", phase, err)
		}
		if got.CreditsReturned.Cmp(tk(42)) != 0 {
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

// TestAsk_FreeFormHashesAreLengthBounded — contentHash and answerHash end up in
// a PERMANENT packed escrow record, so they are capped at the door like every
// other free-form field in this contract (MaxOfferTitleLen's own reasoning).
// Before MaxHashLen they were bounded only by the outer Hive transaction size,
// which this contract does not control and did not cite.
func TestAsk_FreeFormHashesAreLengthBounded(t *testing.T) {
	s := NewMemStore()
	curveMarket(s, creator1, 1000)
	setMoney(s, kFace(creator1), big.NewInt(9090))
	setMoney(s, kBal(creator1, asker1), tk(50_000))
	askBlock := seedSettleObs(s, creator1, 1000, big.NewInt(2000))
	activateMarket(s, creator1, askBlock)

	long := strings.Repeat("a", MaxHashLen+1)
	if _, err := askAt0(s, asker1, creator1, askBlock, tk(10), long, MinAskDeadline); err == nil {
		t.Fatal("an over-long contentHash was accepted into a permanent record")
	}
	// Exactly at the cap is legal — the bound must not be off by one, or a
	// legitimate 128-char address is refused.
	atCap := strings.Repeat("a", MaxHashLen)
	res, err := askAt0(s, asker1, creator1, askBlock, tk(10), atCap, MinAskDeadline)
	if err != nil {
		t.Fatalf("a contentHash of exactly MaxHashLen was refused: %v", err)
	}
	if _, err := Answer(s, creator1, creator1, askBlock+1, res.Seq, long); err == nil {
		t.Fatal("an over-long answerHash was accepted")
	}
	if _, err := Answer(s, creator1, creator1, askBlock+1, res.Seq, atCap); err != nil {
		t.Fatalf("an answerHash of exactly MaxHashLen was refused: %v", err)
	}
}

// ---------------------------------------------------------------------------
// EVENT-HASH SANITISATION (DEFECT FIX 2026-08-19, PRUNED finding F8)
//
// These two guards were PROMOTED here from the audit's own detector file, where
// they lived asserting the vulnerable behaviour. They are inverted now: they
// pin the refusal instead of documenting the hole. Same five cases as the
// detector carried.
//
// The hole: a control byte in contentHash/answerHash makes the emitted
// EvAsked/EvAnswered JSON invalid, and the indexer silently drops an event it
// cannot unmarshal. Measured consequences were an indexer balance fold that
// disagreed with the chain by the full ask size, and — through answerHash,
// the only event carrying creditsToCreator — a creator the wind-down keeper
// can no longer see at all.
// ---------------------------------------------------------------------------

// ctrlByteCases are the bytes an event payload must never carry. DEL (0x7f) is
// included even though Go's own decoder tolerates a raw DEL inside a JSON
// string: it is a non-printable control character with no legitimate place in a
// content hash, and validOfferTitle has excluded it since 2026-07-28. Matching
// its rule exactly is the point — this whole finding is a sibling that was
// missed when that one was fixed.
var ctrlByteCases = []struct {
	name string
	hash string
}{
	{"NUL", "a\x00b"},
	{"newline", "a\x0ab"},
	{"ESC", "a\x1bb"},
	{"DEL_0x7f", "a\x7fb"},
}

func TestAsk_ControlByteInContentHashRefused(t *testing.T) {
	for _, tc := range ctrlByteCases {
		t.Run(tc.name, func(t *testing.T) {
			s := NewMemStore()
			curveMarket(s, creator1, 100)
			setMoney(s, kFace(creator1), big.NewInt(1000))
			setMoney(s, kBal(creator1, asker1), tk(5000))
			block := seedSettleObs(s, creator1, 1000, big.NewInt(400))
			activateMarket(s, creator1, block)

			_, err := askAt0(s, asker1, creator1, block, tk(3), tc.hash, MinAskDeadline)
			if err == nil {
				t.Fatalf("Ask accepted contentHash %q — the emitted event would be invalid JSON "+
					"and the indexer would silently drop it", tc.hash)
			}
			if got := askErrSymbol(err); got != "INPUT" {
				t.Fatalf("refused with %s, want INPUT", got)
			}
		})
	}

	// ANTI-VACUITY: a clean hash must still be accepted, or the four refusals
	// above prove only that Ask is broken.
	s := NewMemStore()
	curveMarket(s, creator1, 100)
	setMoney(s, kFace(creator1), big.NewInt(1000))
	setMoney(s, kBal(creator1, asker1), tk(5000))
	block := seedSettleObs(s, creator1, 1000, big.NewInt(400))
	activateMarket(s, creator1, block)
	if _, err := askAt0(s, asker1, creator1, block, tk(3), "a-b_c.d", MinAskDeadline); err != nil {
		t.Fatalf("a control-free hash was refused: %v — the guard is too wide", err)
	}
}

func TestAnswer_ControlByteInAnswerHashRefused(t *testing.T) {
	for _, tc := range ctrlByteCases {
		t.Run(tc.name, func(t *testing.T) {
			s := NewMemStore()
			curveMarket(s, creator1, 100)
			activateMarket(s, creator1, 1000)
			mkPendingEscrow(s, creator1, 0, asker1, 3, 5000, "cid-1", 120)

			_, err := Answer(s, creator1, creator1, 1100, 0, tc.hash)
			if err == nil {
				t.Fatalf("Answer accepted answerHash %q — this is the byte that hides a "+
					"creator's own position from the wind-down keeper", tc.hash)
			}
			if got := askErrSymbol(err); got != "INPUT" {
				t.Fatalf("refused with %s, want INPUT", got)
			}
		})
	}

	// ANTI-VACUITY.
	s := NewMemStore()
	curveMarket(s, creator1, 100)
	activateMarket(s, creator1, 1000)
	mkPendingEscrow(s, creator1, 0, asker1, 3, 5000, "cid-1", 120)
	if _, err := Answer(s, creator1, creator1, 1100, 0, "a-b_c.d"); err != nil {
		t.Fatalf("a control-free answerHash was refused: %v — the guard is too wide", err)
	}
}

// TestReclaim_OutcomeIsIdenticalWhoeverPushesIt pins the property that settles
// PRUNED finding F18: Reclaim is permissionless, so a stranger can push an
// abandoned escrow and that push runs graduate() on the ASKER — which reads at
// first glance like the third-party graduate transfer.go's F-C1 ruling refuses.
//
// The two are different acts, and this is the test that says so in code rather
// than in a comment: whoever presses the button, the asker must end in exactly
// the same state. A stranger can choose WHEN, never WHAT. If this ever fails,
// permissionless reclaim really has become a lever a third party can pull
// against a holder, and the F-C1 objection would apply to it after all.
func TestReclaim_OutcomeIsIdenticalWhoeverPushesIt(t *testing.T) {
	// Past one full maturity window, or graduate() has nothing to do and the
	// comparison below is between two no-ops.
	deadline := ExitTaxDecayBlocks + 500
	block := deadline + ReclaimGrace + 1

	// Two identical worlds, differing only in who calls Reclaim.
	build := func() *MemStore {
		s := NewMemStore()
		curveMarket(s, creator1, 100)
		activateMarket(s, creator1, block)
		// An aged pile that has cleared the window, so graduate() has real work
		// to do — otherwise the comparison is vacuous.
		setMoney(s, kBal(creator1, asker1), tk(1000))
		setU64(s, kAcqBlock(creator1, asker1), 1)
		mkPendingEscrow(s, creator1, 0, asker1, 42, deadline, "cid", 7)
		return s
	}

	selfPush, strangerPush := build(), build()
	if _, err := Reclaim(selfPush, asker1, creator1, block, 0); err != nil {
		t.Fatalf("asker's own reclaim: %v", err)
	}
	if _, err := Reclaim(strangerPush, rando1, creator1, block, 0); err != nil {
		t.Fatalf("stranger's reclaim: %v", err)
	}

	// ANTI-VACUITY: graduate() must actually have moved something, or this
	// compares two no-ops.
	if MaturedOf(selfPush, creator1, asker1).Sign() == 0 {
		t.Fatal("setup: nothing graduated, so the comparison proves nothing")
	}

	for _, f := range []struct {
		name string
		get  func(s Store) *big.Int
	}{
		{"maturing balance", func(s Store) *big.Int { return getMoney(s, kBal(creator1, asker1)) }},
		{"matured balance", func(s Store) *big.Int { return MaturedOf(s, creator1, asker1) }},
	} {
		if a, b := f.get(selfPush), f.get(strangerPush); a.Cmp(b) != 0 {
			t.Fatalf("%s differs by caller: asker's own push -> %s, stranger's push -> %s", f.name, a, b)
		}
	}
	if a, b := getU64(selfPush, kAcqBlock(creator1, asker1)), getU64(strangerPush, kAcqBlock(creator1, asker1)); a != b {
		t.Fatalf("hold clock differs by caller: %d vs %d", a, b)
	}
	// And the stranger is never paid, in either world.
	if bal := getMoney(strangerPush, kBal(creator1, rando1)); bal.Sign() != 0 {
		t.Fatalf("the pusher was credited %s", bal)
	}
}
