package core

import (
	"math/big"
	"math/rand"
	"strings"
	"testing"
)

// maturity_property_test.go — THE EXECUTABLE SPECIFICATION FOR TOKEN MATURITY.
//
// The user ruling this suite encodes: "TOKEN MATURITY — applies to everyone,
// you're allowed to trade it, it still fulfils its purpose." Maturity belongs to
// the TOKENS, travels with them, and can be NEITHER MANUFACTURED NOR DESTROYED
// by moving them.
//
// This file is written BEFORE the implementation, on purpose. Every property
// below is a running program, not a paragraph, and every one of them is a fuzz
// property over wide random ranges rather than a fixed example — a fixed-example
// suite cannot catch a rounding error, and a rounding error in the wrong
// direction is a laundering channel.
//
// THE TWO PROVEN DEFECTS THIS SUITE MUST FAIL ON, BEFORE THE FIX:
//
//   - THE AGE SPONGE: heldBlocksAt is UNBOUNDED (only the RATE clamps at
//     ExitTaxDecayBlocks, in ExitTaxBpsAt — the STORED age has no ceiling), so a
//     whale holding a year-old pile (10,512,000 blocks of banked age against a
//     1,209,600-block window) absorbs fresh tokens into a merged clock that is
//     still past the window: the fresh slice's 20% simply evaporates. The excess
//     age is unbounded, so the laundering capacity is unbounded and permanent.
//   - THE MIRROR IMAGE: TransferCredits credits the recipient at age `block`
//     regardless of the SENDER's holding time, so an honest holder moving tokens
//     between their own accounts DESTROYS the maturity and pays the maximum tax.
//
// WHAT EACH PROPERTY IS MEASURING, AND WHY IT IS THE RIGHT UNIT.
//
// The exit tax on any exit is  ceil(proceeds · τ(age) / 10000).  Proceeds are a
// pure function of the curve slice (path-independent, curve.go L4) and are the
// SAME whoever holds the tokens — so the only thing an attacker can move is the
// AGE attached to each token. The conserved quantity is therefore per-token:
//
//	CAPACITY(position) = balance × τ(age)          [token·bps]
//	AGE-WEIGHT W(market) = Σ balance × min(age, Dt) [token·blocks]
//
// Capacity is what a merge must conserve (P1); age-weight is the ledger no
// sequence of operations may inflate (P2). Money-level statements are made
// SEPARATELY against real curve slices (P2b, P3b, P4c), because tokens are not
// fungible in money terms on a convex curve and a token-level property alone
// would be a claim this suite has not earned.
//
// W IS COMPUTED HERE FROM STORED STATE, DELIBERATELY NOT VIA heldBlocksAt.
// That is the single most important line in this file. A fix that clamps the age
// only on READ leaves the STORED clock free to bank unbounded age and the sponge
// survives inside the weighted average; recomputing W from kAcqBlock directly is
// what makes P2 and P6 catch that, instead of measuring the read-side clamp
// against itself.

const mpDt = ExitTaxDecayBlocks

func mpBig(v uint64) *big.Int { return new(big.Int).SetUint64(v) }

// mpStoredAge is the age (c,h)'s STORED clock represents at `block`, capped at
// the decay window because that is all the tax schedule can ever see: an age of
// Dt and an age of 40·Dt are the same rate (0), so comparing UNcapped ages would
// score the sponge as harmless. Unset (0) reads as maximally fresh, matching
// holdclock.go's zero-value convention.
//
// Computed from kAcqBlock, NOT from heldBlocksAt — see the file header.
func mpStoredAge(s Store, c, h string, block uint64) uint64 {
	w := getU64(s, kAcqBlock(c, h))
	if w == 0 || w >= block {
		return 0
	}
	age := block - w
	if age > mpDt {
		return mpDt
	}
	return age
}

// mpRate is the rate a position actually pays, read through the REAL schedule
// and the REAL clock reader (this is the number the money paths use).
func mpRate(s Store, c, h string, block uint64) uint64 {
	return ExitTaxBpsAt(heldBlocksAt(s, c, h, block))
}

// mpCapacity is balance × rate, in token·bps.
func mpCapacity(s Store, c, h string, block uint64) *big.Int {
	return new(big.Int).Mul(getMoney(s, kBal(c, h)), mpBig(mpRate(s, c, h, block)))
}

// mpExactCapacity is the capacity the EXACT (unrounded) affine schedule would
// charge: balance · MaxExitTaxBps · (Dt − cappedAge) / Dt, kept as a numerator
// over Dt so the comparison stays in exact integers.
func mpExactCapacityNum(bal *big.Int, cappedAge uint64) *big.Int {
	return new(big.Int).Mul(
		new(big.Int).Mul(bal, mpBig(MaxExitTaxBps)),
		mpBig(mpDt-cappedAge),
	)
}

// mpMergeTol is the DERIVED rounding tolerance for a two-lot merge, in
// token·bps. It is derived, not chosen:
//
//	τ(a) = ceil(MaxExitTaxBps·(Dt−a)/Dt)      ⇒ 0 <= τ(a) − L(a) < 1 bps
//	a_m  = floor(size-weighted mean of ages)  ⇒ 0 <= mean − a_m  < 1 block
//	L affine ⇒ b_m·L(a_m) − Σ bᵢ·L(aᵢ) = b_m·(MaxExitTaxBps/Dt)·(mean − a_m)
//
// so   −b_m  <  capMerged − Σ capᵢ  <  b_m·(1 + MaxExitTaxBps/Dt).
// MaxExitTaxBps/Dt = 2000/1209600 ≈ 0.00165 bps per block, i.e. the age-average
// rounding is three orders of magnitude below the rate's own ceil granularity;
// the tolerance is dominated by "1 bps per token" and the +1 absorbs the integer
// rounding of the bound itself.
func mpMergeTol(bm *big.Int) *big.Int {
	t := new(big.Int).Mul(bm, mpBig(MaxExitTaxBps))
	t.Div(t, mpBig(mpDt))
	t.Add(t, bm)
	return t.Add(t, big.NewInt(1))
}

func mpRandBal(r *rand.Rand) *big.Int {
	switch r.Intn(4) {
	case 0:
		return big.NewInt(r.Int63n(4) + 1) // dust — where ceil/floor actually bite
	case 1:
		return big.NewInt(r.Int63n(1000) + 1)
	case 2:
		return big.NewInt(r.Int63n(1_000_000) + 1)
	default:
		return big.NewInt(r.Int63n(MaxCap) + 1) // up to the protocol cap, 1e9
	}
}

// mpRandAge spans fresh, mid-window, BOTH boundary neighbourhoods, and far past
// the window — the last bucket is the age sponge's input and must not be
// dropped from any range.
func mpRandAge(r *rand.Rand) uint64 {
	switch r.Intn(5) {
	case 0:
		return uint64(r.Int63n(4))
	case 1:
		return uint64(r.Int63n(int64(mpDt)))
	case 2:
		return mpDt - uint64(r.Int63n(3))
	case 3:
		return mpDt + uint64(r.Int63n(3))
	default:
		return uint64(r.Int63n(int64(5 * mpDt)))
	}
}

// mpAgeWeight is the market-wide age-weight ledger W = Σ bal·min(age, Dt),
// computed from STORED clocks (see the file header for why that matters).
func mpAgeWeight(s *MemStore, c string, block uint64) *big.Int {
	prefix := kBal(c, "")
	total := big.NewInt(0)
	matched := 0
	for _, k := range s.Keys() {
		if !strings.HasPrefix(k, prefix) {
			continue
		}
		matched++
		h := k[len(prefix):]
		bal := getMoney(s, k)
		if bal.Sign() == 0 {
			continue
		}
		total.Add(total, new(big.Int).Mul(bal, mpBig(mpStoredAge(s, c, h, block))))
	}
	// ★ BOTH BUCKETS (2026-07-30). A matured token has served the full window,
	// so its contribution to the age-weight ledger is bal·Dt — the maximum, and
	// frozen there forever. Counting only the maturing family would make this
	// ledger measure a shrinking subset of the tokens as holders graduate, and
	// "no operation increases W" would become trivially satisfiable by moving
	// tokens out of the thing being measured.
	matchedMatured, maturedTotal := mpMaturedWeight(s, c)
	total.Add(total, maturedTotal)
	mpAssertScanned(matched+matchedMatured, s, c, "mpAgeWeight")
	return total
}

// mpMaturedWeight totals the matured family for one creator and reports how
// many keys it matched. The matured key is TRANSPOSED (bal|<holder>|<creator>),
// so the creator is a suffix and this cannot be a prefix scan.
func mpMaturedWeight(s *MemStore, c string) (matched int, weight *big.Int) {
	suffix := "|" + c
	weight = big.NewInt(0)
	for _, k := range s.Keys() {
		if !strings.HasPrefix(k, "bal|") || !strings.HasSuffix(k, suffix) {
			continue
		}
		matched++
		h := k[len("bal|") : len(k)-len(suffix)]
		bal := getMatured(s, c, h)
		if bal.Sign() == 0 {
			continue
		}
		weight.Add(weight, new(big.Int).Mul(bal, mpBig(mpDt)))
	}
	return matched, weight
}

// mpAssertScanned is the non-vacuity guard for every prefix scan in this file.
//
// ★ WHY IT PANICS RATHER THAN RETURNING ZERO (M0 scrutiny, 2026-07-30, proven by
// mutation): with the pre-M0 hardcoded "bal|" prefix restored, EVERY ONE of the
// thirteen P1–P7 property tests in this file still PASSED — because the scan
// matched nothing, the ledger was 0, and P2's assertions reduce to `0 > 0` and
// `0 < 0`, both false, both green. The executable specification for the entire
// anti-laundering guarantee was satisfied by an empty ledger.
//
// Deriving the prefix from kBal() closes the rename hazard, but not the class:
// M1 adds a SECOND balance family (kMatured) beside this one, so a scan that
// silently covers only half the tokens is the same trap one milestone away. A
// property that measures nothing must fail loudly, not pass quietly.
//
// A panic is the right instrument here: these are helpers with no *testing.T,
// and a zero scan on a populated market is a broken harness rather than a
// falsified property — it must never be swallowed by an assertion that happens
// to hold at zero.
func mpAssertScanned(matched int, s *MemStore, c, who string) {
	if matched > 0 {
		return
	}
	if getMoney(s, kSupply(c)).Sign() == 0 {
		return // genuinely empty market: nothing to scan, nothing to prove
	}
	panic(who + ": scanned ZERO balance keys for creator " + c +
		" while supply is non-zero — the prefix no longer matches the balance " +
		"family, so every property built on this ledger is passing vacuously")
}

// ---------------------------------------------------------------------------
// P1 CONSERVATION
//
// "Merging any two positions yields a total exit tax exactly equal to the sum of
// the two positions' taxes, up to a rounding residue of at most one basis point
// per token."
//
// Stated in capacity (balance × rate) because the rate is the only thing a merge
// can move; the money form is P2b/P3b.
// ---------------------------------------------------------------------------

func TestP1_Conservation_MergePreservesTaxCapacity(t *testing.T) {
	r := rand.New(rand.NewSource(0x50A17E))
	const iters = 4000
	const c = "p1creator"

	for i := 0; i < iters; i++ {
		// The merge block M is far enough in that any age below can be
		// subtracted from it without underflowing.
		M := 8*mpDt + uint64(r.Int63n(int64(mpDt)))
		a1, a2 := mpRandAge(r), mpRandAge(r)
		acq1, acq2 := M-a1, M-a2
		b1, b2 := mpRandBal(r), mpRandBal(r)
		bm := new(big.Int).Add(b1, b2)

		// --- world A: the two lots held SEPARATELY, each with its own clock ---
		sA := NewMemStore()
		creditInflow(sA, c, "lot1", b1, acq1) // fresh account ⇒ clock == acq1 exactly (C-14)
		creditInflow(sA, c, "lot2", b2, acq2)
		cap1 := mpCapacity(sA, c, "lot1", M)
		cap2 := mpCapacity(sA, c, "lot2", M)
		capSum := new(big.Int).Add(cap1, cap2)

		// --- world B: the SAME two lots merged into one holder at block M ---
		// creditInflowAt IS the merge primitive: a Buy passes acq == block, a
		// transfer passes the sender's clock. Both shapes are covered here.
		sB := NewMemStore()
		creditInflow(sB, c, "m", b1, acq1)
		creditInflowAt(sB, c, "m", b2, acq2, M)
		capM := mpCapacity(sB, c, "m", M)

		if got := getMoney(sB, kBal(c, "m")); got.Cmp(bm) != 0 {
			t.Fatalf("iter %d: merged balance %s != %s — the merge lost tokens", i, got, bm)
		}

		// (1) NO MANUFACTURE — the hard half, no tolerance at all: the merged
		// capacity is never below what the EXACT affine schedule would charge
		// the two lots. This is the assertion the age sponge fails: a year-old
		// pile swallowing a fresh slice reads capM == 0 while the fresh slice
		// alone owes MaxExitTaxBps.
		lhs := new(big.Int).Mul(capM, mpBig(mpDt))
		rhs := new(big.Int).Add(
			mpExactCapacityNum(b1, mpStoredAge(sA, c, "lot1", M)),
			mpExactCapacityNum(b2, mpStoredAge(sA, c, "lot2", M)),
		)
		if lhs.Cmp(rhs) < 0 {
			t.Fatalf("P1 MANUFACTURE (iter %d): merging (%s tokens, age %d) with (%s tokens, age %d) at block %d "+
				"yields capacity %s token·bps; the exact schedule owes at least %s/%d. "+
				"Maturity was created out of nothing.",
				i, b1, a1, b2, a2, M, capM, rhs, mpDt)
		}

		// (2) TWO-SIDED, within the derived tolerance: the merge neither
		// destroys nor invents more than one bps per token.
		tol := mpMergeTol(bm)
		diff := new(big.Int).Sub(capM, capSum)
		if diff.CmpAbs(tol) > 0 {
			t.Fatalf("P1 DRIFT (iter %d): |merged %s − (lot1 %s + lot2 %s)| = %s exceeds the derived tolerance %s "+
				"(b1=%s age %d, b2=%s age %d, block %d)",
				i, capM, cap1, cap2, new(big.Int).Abs(diff), tol, b1, a1, b2, a2, M)
		}
	}
}

// The two exhibits named in the defect report, at exact integers. These are
// examples, not the property — the fuzz above is the property — but a named
// exhibit is what makes a regression readable.
func TestP1_Conservation_NamedSpongeExhibits(t *testing.T) {
	const c = "p1exhibit"
	oneYear := uint64(365 * BlocksPerDay) // 10,512,000 blocks — 8.7× the window

	// NOTE ON THE AGES CHOSEN — both lots must be aged PAST the window for the
	// sponge to bite, and that is the whole point of the defect. An "aged" lot
	// sitting exactly AT the window boundary does NOT reproduce it: measured on
	// the unfixed code, 100 tokens at exactly ExitTaxDecayBlocks merged with 100
	// fresh gives 1000 bps (correct), while the same 100 aged ONE YEAR gives 0.
	// The excess beyond the window is the laundering capacity, so every exhibit
	// here is stated in terms of a genuinely over-aged pile.
	cases := []struct {
		name       string
		bAged      int64
		ageAged    uint64
		bFresh     int64
		wantAtLeas uint64 // minimum acceptable merged rate, bps
	}{
		// 1000 tokens aged a year absorb 100 fresh: the fresh 100/1100 of the
		// position owes 2000·100/1100 = 181.8 bps ⇒ 182 after the schedule ceil.
		{"whale-year-old-absorbs-fresh", 1000, oneYear, 100, 181},
		// Equal sizes, the aged half a year old: the merged position must land at
		// half the maximum rate. Unfixed: 0.
		{"aged-100-plus-fresh-100", 100, oneYear, 100, 999},
		// A single year-old token must not shelter a whole fresh position.
		{"one-aged-token-shelters-nothing", 1, oneYear, 10_000, 1998},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			M := 20 * mpDt
			s := NewMemStore()
			creditInflow(s, c, "whale", big.NewInt(tc.bAged), M-tc.ageAged)
			creditInflow(s, c, "whale", big.NewInt(tc.bFresh), M) // the fresh slice, at M

			got := mpRate(s, c, "whale", M)
			if got < tc.wantAtLeas {
				t.Fatalf("THE AGE SPONGE: %d tokens aged %d blocks absorbed %d fresh tokens and the merged "+
					"position pays %d bps; the fresh slice alone owes at least %d bps of the merged size. "+
					"%d%% of the fresh slice's tax evaporated.",
					tc.bAged, tc.ageAged, tc.bFresh, got, tc.wantAtLeas,
					100-(100*got)/tc.wantAtLeas)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// P2 NO MANUFACTURE
//
// "No sequence of buys, transfers and partial sells across any number of
// colluding accounts produces less total tax than honest behaviour — because the
// market's age-weight ledger Σ balance × min(age, window) is never increased by
// any operation, and buys add exactly zero age at the block they land."
// ---------------------------------------------------------------------------

// mpWorld is a real ACTIVE market driven only through the public money paths.
type mpWorld struct {
	s     *MemStore
	c     string
	block uint64
}

func mpNewWorld(c string, start uint64) *mpWorld {
	s := NewMemStore()
	setU64(s, kRegisteredAt(c), 1)
	setU64(s, kPaidUntil(c), start+100_000*SubscriptionPeriod) // never lapses inside a run
	setMoney(s, kCap(c), big.NewInt(MaxCap))
	return &mpWorld{s: s, c: c, block: start}
}

// mpTotals returns the market's total balance and its total tax CAPACITY
// (Σ bal·τ), both read through the real rate path.
func mpTotals(s *MemStore, c string, block uint64) (bal, capacity *big.Int) {
	prefix := kBal(c, "")
	bal, capacity = big.NewInt(0), big.NewInt(0)
	matched := 0
	for _, k := range s.Keys() {
		if !strings.HasPrefix(k, prefix) {
			continue
		}
		matched++
		h := k[len(prefix):]
		b := getMoney(s, k)
		if b.Sign() == 0 {
			continue
		}
		bal.Add(bal, b)
		capacity.Add(capacity, mpCapacity(s, c, h, block))
	}
	// Matured tokens count toward the balance and contribute ZERO capacity —
	// their rate is 0 by definition, which is exactly what "matured" means.
	suffix := "|" + c
	for _, k := range s.Keys() {
		if !strings.HasPrefix(k, "bal|") || !strings.HasSuffix(k, suffix) {
			continue
		}
		matched++
		bal.Add(bal, getMatured(s, c, k[len("bal|"):len(k)-len(suffix)]))
	}
	mpAssertScanned(matched, s, c, "mpTotals")
	return bal, capacity
}

func TestP2_NoManufacture_AgeWeightLedger(t *testing.T) {
	r := rand.New(rand.NewSource(0xA6E1E06))
	holders := []string{"col1", "col2", "col3", "col4", "col5"}
	const c = "p2creator"

	for run := 0; run < 40; run++ {
		w := mpNewWorld(c, 1_000_000+uint64(r.Int63n(1000)))

		for op := 0; op < 120; op++ {
			// Advance time. The big jumps are deliberate: a position must be
			// able to age WELL PAST the window between two writes, because that
			// is precisely the state in which the sponge fires.
			switch r.Intn(4) {
			case 0:
				w.block += uint64(r.Int63n(50) + 1)
			case 1:
				w.block += uint64(r.Int63n(int64(mpDt)) + 1)
			default:
				w.block += mpDt + uint64(r.Int63n(int64(2*mpDt)))
			}

			wBefore := mpAgeWeight(w.s, c, w.block)
			h := holders[r.Intn(len(holders))]
			bal := getMoney(w.s, kBal(c, h))

			var what string
			switch {
			case bal.Sign() == 0 || r.Intn(3) == 0:
				n := big.NewInt(r.Int63n(500) + 1)
				if _, err := Buy(w.s, h, c, w.block, n); err != nil {
					t.Fatalf("run %d op %d: Buy rejected: %v", run, op, err)
				}
				what = "Buy"
			case r.Intn(2) == 0:
				to := holders[r.Intn(len(holders))]
				if to == h {
					continue
				}
				amt := new(big.Int).Add(big.NewInt(1), new(big.Int).Rand(r, bal))
				if amt.Cmp(bal) > 0 {
					amt.Set(bal)
				}
				if err := TransferCredits(w.s, c, h, to, w.block, amt); err != nil {
					t.Fatalf("run %d op %d: TransferCredits rejected: %v", run, op, err)
				}
				what = "TransferCredits"
			default:
				amt := new(big.Int).Add(big.NewInt(1), new(big.Int).Rand(r, bal))
				if amt.Cmp(bal) > 0 {
					amt.Set(bal)
				}
				if _, err := Sell(w.s, h, c, w.block, amt); err != nil {
					t.Fatalf("run %d op %d: Sell rejected: %v", run, op, err)
				}
				what = "Sell"
			}

			wAfter := mpAgeWeight(w.s, c, w.block)

			// (1) NO OPERATION INCREASES THE AGE-WEIGHT LEDGER, at the block it
			// runs at. Buys add tokens with exactly zero age; transfers move age
			// with the tokens; sells remove it. Nothing creates it.
			if wAfter.Cmp(wBefore) > 0 {
				t.Fatalf("P2 MANUFACTURE (run %d op %d, %s at block %d by %s): age-weight rose %s → %s (+%s token·blocks). "+
					"Maturity was created by an operation.",
					run, op, what, w.block, h, wBefore, wAfter, new(big.Int).Sub(wAfter, wBefore))
			}

			// (2) THE TWO UNITS ARE TIED TOGETHER. The ledger is in
			// token·blocks; the money paths charge in token·bps. This binds
			// them: the rate everyone is ACTUALLY charged is never below what
			// the age ledger says they owe,
			//
			//	C·Dt >= MaxExitTaxBps·(totalBalance·Dt − W)
			//
			// which is exact (τ(a) >= Max·(Dt−a)/Dt for every a, with equality
			// but for the schedule's ceil). Without it, a fix could cap the
			// ledger's inputs and still hand out a stale rate on the read path —
			// the ledger would look clean while the money was wrong.
			totalBal, capacity := mpTotals(w.s, c, w.block)
			lhs := new(big.Int).Mul(capacity, mpBig(mpDt))
			rhs := new(big.Int).Sub(new(big.Int).Mul(totalBal, mpBig(mpDt)), wAfter)
			rhs.Mul(rhs, mpBig(MaxExitTaxBps))
			if lhs.Cmp(rhs) < 0 {
				t.Fatalf("P2 UNIT MISMATCH (run %d op %d, %s at block %d): charged capacity %s token·bps is below the "+
					"%s/%d the age ledger owes (balance %s, age-weight %s)",
					run, op, what, w.block, capacity, rhs, mpDt, totalBal, wAfter)
			}
		}
	}
}

// P2c — THE RESIDUAL, PINNED AND PRICED RATHER THAN HIDDEN.
//
// One averaged clock is a LOSSY summary of a set of lots, and the loss is real:
// τ is affine on [0, window] but FLAT at 0 beyond it, so two lots that would
// individually cross the window at different times are not perfectly represented
// by their mean. Measured: 1 matured token merged with 1 fresh one is EXACTLY
// neutral at the merge block (gap 0), and half a window later the merged pair
// pays 0 where per-lot accounting would still charge 1000 bps on the fresh half.
//
// The consequence, stated plainly: A ALREADY-MATURED TOKENS ACCELERATE THE
// MATURATION OF F FRESHLY-BOUGHT ONES. That is the honest residual of a
// single-clock design, and the alternative — a per-holder LOT LIST — is
// unbounded state that any stranger can grow with dust transfers, i.e. an
// unbounded loop on a fund path (RULING G) and a griefing vector. So the
// residual is accepted, and it is BOUNDED here so it can never quietly widen:
//
//	(a) it is NEVER instant — merging fresh tokens in always leaves a strictly
//	    positive rate, so no amount of aged stock buys a same-block tax-free
//	    exit for a fresh buy. This is the whole of the age sponge, and it is
//	    what fails on the unfixed code.
//	(b) the fresh tokens must still be HELD for at least their own fraction of
//	    the window, Dt·F/(A+F), before the position reaches zero.
func TestP2c_AcceleratedMaturation_BoundedAndNeverInstant(t *testing.T) {
	r := rand.New(rand.NewSource(0xACCE1))
	const c = "p2c"

	for i := 0; i < 2000; i++ {
		A := big.NewInt(r.Int63n(MaxCap) + 1)
		F := big.NewInt(r.Int63n(1_000_000) + 1)
		M := 9 * mpDt

		s := NewMemStore()
		// A tokens matured well past the window, then F fresh ones merged in.
		creditInflow(s, c, "whale", A, M-(mpDt+uint64(r.Int63n(int64(4*mpDt)))))
		creditInflow(s, c, "whale", F, M)

		// (a) never instant.
		if got := mpRate(s, c, "whale", M); got == 0 {
			t.Fatalf("P2c INSTANT SHELTER (iter %d): %s matured tokens absorbed %s fresh ones and the merged "+
				"position pays ZERO in the same block. Fresh tokens must never be tax-free on arrival.", i, A, F)
		}

		// (b) zero is not reached before Dt·F/(A+F) blocks of genuine holding.
		// floor the bound and step one block inside it, so the check is on a
		// block the position must still be taxed at.
		bound := new(big.Int).Mul(mpBig(mpDt), F)
		bound.Div(bound, new(big.Int).Add(A, F))
		if bound.Sign() > 0 && bound.IsUint64() {
			at := M + bound.Uint64() - 1
			if got := mpRate(s, c, "whale", at); got == 0 {
				t.Fatalf("P2c SHELTER TOO FAST (iter %d): %s matured + %s fresh reached a zero rate after %d blocks; "+
					"the fresh fraction owes at least %s blocks of holding", i, A, F, bound.Uint64()-1, bound)
			}
		}
	}
}

// P2b — the money form of no-manufacture, two-sided and bounded by real curve
// slices, so the claim is about HBD and not about token·bps.
//
// A whale holds A tokens two full decay windows old (rate 0), buys F fresh
// tokens, and dumps the lot in one Sell. The tax must be:
//
//	>= 20% of the CHEAPEST F tokens on the curve  (it cannot be laundered away)
//	<= 20% of the DEAREST  F tokens on the curve  (it cannot be over-charged)
//
// Both bounds follow from the curve being non-decreasing: the average price of
// the whole position lies between the average price of its bottom F and its top
// F tokens. The slack term is the derived rounding residue, nothing more.
func TestP2_NoManufacture_SpongeMoneyBounds(t *testing.T) {
	r := rand.New(rand.NewSource(0x5F0A6E))
	const c = "p2money"

	for i := 0; i < 200; i++ {
		A := big.NewInt(r.Int63n(20_000) + 100)
		F := big.NewInt(r.Int63n(5_000) + 1)

		w := mpNewWorld(c, 3_000_000)
		if _, err := Buy(w.s, "whale", c, w.block, A); err != nil {
			t.Fatal(err)
		}
		sellBlock := w.block + 2*mpDt
		if _, err := Buy(w.s, "whale", c, sellBlock, F); err != nil {
			t.Fatal(err)
		}

		S := getMoney(w.s, kSupply(c))
		topF, err := SellProceeds(S, F) // area(S) − area(S−F): the DEAREST F tokens
		if err != nil {
			t.Fatal(err)
		}
		bottomF := Area(F) // area(F) − area(0): the CHEAPEST F tokens
		whole := Area(S)

		sr, err := Sell(w.s, "whale", c, sellBlock, S)
		if err != nil {
			t.Fatal(err)
		}

		// slack = whole·(Dt + MaxExitTaxBps)/(Dt·10000) + 2 — the schedule's
		// 1-bps ceil plus the 1-block floor on the merged age, applied to the
		// whole proceeds, plus two units of integer rounding.
		slack := new(big.Int).Mul(whole, mpBig(mpDt+MaxExitTaxBps))
		slack.Div(slack, new(big.Int).Mul(mpBig(mpDt), big.NewInt(10000)))
		slack.Add(slack, big.NewInt(2))

		lo := new(big.Int).Sub(ExitTaxOn(bottomF, MaxExitTaxBps), slack)
		hi := new(big.Int).Add(ExitTaxOn(topF, MaxExitTaxBps), slack)

		if sr.Tax.Cmp(lo) < 0 {
			t.Fatalf("P2b LAUNDERED (iter %d): %s aged tokens absorbed %s fresh ones; the dump paid %s tax "+
				"but the fresh slice owes at least %s (20%% of the cheapest %s tokens, minus %s slack). "+
				"rate applied = %d bps, held = %d blocks",
				i, A, F, sr.Tax, lo, F, slack, sr.TaxBps, sr.HeldBlocks)
		}
		if sr.Tax.Cmp(hi) > 0 {
			t.Fatalf("P2b OVER-CHARGED (iter %d): dump paid %s tax, above the %s ceiling "+
				"(20%% of the dearest %s tokens plus %s slack)", i, sr.Tax, hi, F, slack)
		}
	}
}

// ---------------------------------------------------------------------------
// P3 NO DESTRUCTION
//
// "Moving tokens between accounts never increases the total tax owed on them."
// ---------------------------------------------------------------------------

// P3a — the exact half. A transfer into an EMPTY account is a pure relocation:
// the recipient must read the sender's rate EXACTLY, at every query block, with
// no tolerance whatsoever. This is the mirror-image defect's kill shot.
func TestP3_NoDestruction_TransferToEmptyPreservesRateExactly(t *testing.T) {
	r := rand.New(rand.NewSource(0xD3577))
	const c = "p3empty"

	for i := 0; i < 4000; i++ {
		acq := 6*mpDt + uint64(r.Int63n(int64(mpDt)))
		gap := mpRandAge(r) // how long the sender held before sending
		T := acq + gap      // the transfer block
		bal := mpRandBal(r)
		amt := new(big.Int).Add(big.NewInt(1), new(big.Int).Rand(r, bal))
		if amt.Cmp(bal) > 0 {
			amt.Set(bal)
		}

		s := NewMemStore()
		creditInflow(s, c, "owner", bal, acq)
		senderRateBefore := mpRate(s, c, "owner", T)

		if err := TransferCredits(s, c, "owner", "alt", T, amt); err != nil {
			t.Fatalf("iter %d: TransferCredits rejected: %v", i, err)
		}

		// The sender's remainder is not re-aged by sending (existing C-13 rule).
		if got := mpRate(s, c, "owner", T); got != senderRateBefore {
			t.Fatalf("iter %d: sending re-aged the sender: %d → %d bps", i, senderRateBefore, got)
		}
		// The moved tokens keep their maturity, exactly, now and later.
		for _, q := range []uint64{T, T + 1, T + mpDt/2, T + mpDt, T + 4*mpDt} {
			want := ExitTaxBpsAt(heldBlocksAt(s, c, "owner", q))
			got := ExitTaxBpsAt(heldBlocksAt(s, c, "alt", q))
			if got != want {
				t.Fatalf("P3 DESTRUCTION (iter %d): %s tokens held since block %d were moved to an empty account at "+
					"block %d; at block %d the mover pays %d bps and the moved tokens pay %d bps. "+
					"Maturity was destroyed by moving tokens between accounts.",
					i, amt, acq, T, q, want, got)
			}
		}
	}
}

// P3b — the money form, on the ruling's own case: an honest holder splits a
// position across their own two accounts and then exits. Splitting one sale into
// two costs at most ONE base unit (ceil superadditivity, RULING F: Σceil(xᵢ) <=
// ceil(Σxᵢ) + (k−1)); it must cost nothing else.
func TestP3_NoDestruction_SelfCustodySplitCostsAtMostCeilDust(t *testing.T) {
	r := rand.New(rand.NewSource(0x5911))
	const c = "p3money"

	for i := 0; i < 300; i++ {
		N := big.NewInt(r.Int63n(20_000) + 2)
		age := mpRandAge(r)
		k := new(big.Int).Add(big.NewInt(1), new(big.Int).Rand(r, new(big.Int).Sub(N, big.NewInt(1))))

		mk := func() (*mpWorld, uint64) {
			w := mpNewWorld(c, 4_000_000)
			if _, err := Buy(w.s, "hodler", c, w.block, N); err != nil {
				t.Fatal(err)
			}
			return w, w.block + age
		}

		// (i) sell the whole position in one go
		wA, sellBlock := mk()
		srA, err := Sell(wA.s, "hodler", c, sellBlock, N)
		if err != nil {
			t.Fatal(err)
		}

		// (ii) move k to the holder's OWN alt first, then exit both, same block,
		// same supply path — so the proceeds telescope to exactly the same total.
		wB, _ := mk()
		if err := TransferCredits(wB.s, c, "hodler", "hodler.alt", sellBlock, k); err != nil {
			t.Fatal(err)
		}
		s1, err := Sell(wB.s, "hodler", c, sellBlock, new(big.Int).Sub(N, k))
		if err != nil {
			t.Fatal(err)
		}
		s2, err := Sell(wB.s, "hodler.alt", c, sellBlock, k)
		if err != nil {
			t.Fatal(err)
		}

		gross := new(big.Int).Add(s1.Gross, s2.Gross)
		if gross.Cmp(srA.Gross) != 0 {
			t.Fatalf("iter %d: premise broken — split proceeds %s != whole %s (curve L4)", i, gross, srA.Gross)
		}
		split := new(big.Int).Add(s1.Tax, s2.Tax)
		limit := new(big.Int).Add(srA.Tax, big.NewInt(1))
		if split.Cmp(limit) > 0 {
			t.Fatalf("P3b DESTRUCTION (iter %d): holding %s tokens for %d blocks and exiting costs %s tax; "+
				"moving %s of them to the holder's OWN account first costs %s (+%s). "+
				"Self-custody must be free beyond one unit of ceil dust.",
				i, N, age, srA.Tax, k, split, new(big.Int).Sub(split, srA.Tax))
		}
	}
}

// P3c — multi-hop chains through accounts that may already hold a position.
// Relocation through an EMPTY account is exact (asserted above); a merge into an
// occupied one is bounded by the same P1 tolerance and by nothing else.
func TestP3_NoDestruction_ChainedTransfersBounded(t *testing.T) {
	r := rand.New(rand.NewSource(0xC4A1))
	const c = "p3chain"
	holders := []string{"a", "b", "c", "d"}

	for i := 0; i < 1500; i++ {
		s := NewMemStore()
		start := 7 * mpDt
		total := big.NewInt(0)
		for _, h := range holders {
			b := big.NewInt(r.Int63n(100_000) + 1)
			creditInflow(s, c, h, b, start-mpRandAge(r)%start)
			total.Add(total, b)
		}
		block := start + uint64(r.Int63n(int64(mpDt)))
		capBefore := big.NewInt(0)
		for _, h := range holders {
			capBefore.Add(capBefore, mpCapacity(s, c, h, block))
		}

		for hop := 0; hop < 6; hop++ {
			from := holders[r.Intn(len(holders))]
			to := holders[r.Intn(len(holders))]
			if from == to {
				continue
			}
			bal := getMoney(s, kBal(c, from))
			if bal.Sign() == 0 {
				continue
			}
			amt := new(big.Int).Add(big.NewInt(1), new(big.Int).Rand(r, bal))
			if amt.Cmp(bal) > 0 {
				amt.Set(bal)
			}
			if err := TransferCredits(s, c, from, to, block, amt); err != nil {
				t.Fatalf("iter %d hop %d: %v", i, hop, err)
			}
		}

		capAfter := big.NewInt(0)
		for _, h := range holders {
			capAfter.Add(capAfter, mpCapacity(s, c, h, block))
		}
		// Six merges, each within the per-merge tolerance.
		tol := new(big.Int).Mul(mpMergeTol(total), big.NewInt(6))
		if new(big.Int).Sub(capAfter, capBefore).CmpAbs(tol) > 0 {
			t.Fatalf("P3c (iter %d): six transfers moved total capacity %s → %s, beyond the %s tolerance",
				i, capBefore, capAfter, tol)
		}
	}
}

// ---------------------------------------------------------------------------
// P4 NO GRIEF-PROFIT
//
// "A third party can never profit by re-aging someone else's position, and the
// victim's worst case is bounded by the attacker's donated fraction."
// ---------------------------------------------------------------------------

// P4a — the victim's QUANTIFIED worst case. An attacker donating b_a tokens onto
// a victim holding b_v can raise the victim's rate by at most
//
//	ceil(MaxExitTaxBps · b_a / (b_v + b_a)) + 1  bps
//
// (worst case: the donated tokens are maximally fresh). To move a six-week
// holder from 0% to the full 20% an attacker must donate MORE tokens than the
// victim holds — i.e. hand the victim a second position.
func TestP4_NoGriefProfit_VictimWorstCaseBounded(t *testing.T) {
	r := rand.New(rand.NewSource(0x6816F))
	const c = "p4bound"

	for i := 0; i < 4000; i++ {
		T := 7*mpDt + uint64(r.Int63n(int64(mpDt)))
		bv, ba := mpRandBal(r), mpRandBal(r)
		av, aa := mpRandAge(r), mpRandAge(r)
		if av > T {
			av = T - 1
		}
		if aa > T {
			aa = T - 1
		}

		s := NewMemStore()
		creditInflow(s, c, "victim", bv, T-av)
		creditInflow(s, c, "attacker", ba, T-aa)
		before := mpRate(s, c, "victim", T)
		attackerBalBefore := getMoney(s, kBal(c, "attacker"))

		if err := TransferCredits(s, c, "attacker", "victim", T, ba); err != nil {
			t.Fatalf("iter %d: %v", i, err)
		}
		after := mpRate(s, c, "victim", T)

		if after > before {
			// bound = ceil(MaxExitTaxBps·ba/(bv+ba)) + 1
			num := new(big.Int).Mul(ba, mpBig(MaxExitTaxBps))
			den := new(big.Int).Add(bv, ba)
			bound := mMulDivCeil(num, big.NewInt(1), den)
			bound.Add(bound, big.NewInt(1))
			got := big.NewInt(int64(after - before))
			if got.Cmp(bound) > 0 {
				t.Fatalf("P4 GRIEF (iter %d): donating %s tokens (age %d) onto a %s-token position (age %d) "+
					"raised the victim's rate by %d bps; the donated fraction bounds it at %s bps",
					i, ba, aa, bv, av, after-before, bound)
			}
		}

		// The attacker is strictly poorer in tokens and received nothing back.
		if got := getMoney(s, kBal(c, "attacker")); got.Cmp(new(big.Int).Sub(attackerBalBefore, ba)) != 0 {
			t.Fatalf("iter %d: attacker balance %s, want %s", i, got, new(big.Int).Sub(attackerBalBefore, ba))
		}
	}
}

// P4b — the ATTACKER's side, in money, aimed at the ONE account that actually
// shares in the tax: THE CREATOR (accrueExitTax, 2026-07-27, pays the creator
// half of every non-self exit tax). If re-aging paid anyone, it would pay them.
//
// THE BOUND, and why this one and not a market-timing comparison: the creator's
// half of the extra tax their donation induces must be strictly less than the
// GROSS CURVE VALUE of the tokens they had to give away. That is the tightest
// cost any use of those tokens could have — sell them, keep them, gift them —
// so beating it would make re-aging profitable against every alternative at
// once. It also states the size-weighting requirement in money: the tax base is
// the victim's WHOLE position while the cost is only the donated slice, so a
// rule that let a small donation move a large position's rate by more than the
// donated FRACTION is immediately profitable. A "take the younger clock" or
// "reset the recipient to now" rule — both plausible, both superficially
// treasury-favouring — fail here by orders of magnitude, and nothing else in
// this suite prices them.
func TestP4_NoGriefProfit_CreatorTaxShareBelowDonationValue(t *testing.T) {
	r := rand.New(rand.NewSource(0x6816C))
	const c = "p4creator"

	worstRatioNum, worstRatioDen := big.NewInt(0), big.NewInt(1)
	for i := 0; i < 150; i++ {
		V := big.NewInt(r.Int63n(50_000) + 1000) // the victim's matured position
		g := big.NewInt(r.Int63n(2_000) + 1)     // the creator's re-aging donation

		build := func() (*mpWorld, uint64) {
			w := mpNewWorld(c, 5_000_000)
			if _, err := Buy(w.s, "victim", c, w.block, V); err != nil {
				t.Fatal(err)
			}
			sellBlock := w.block + mpDt + 1 // the victim is fully matured: rate 0
			if _, err := Buy(w.s, c, c, sellBlock, g); err != nil {
				t.Fatal(err)
			}
			return w, sellBlock
		}

		// Baseline: the victim exits untouched. The creator's exit-tax income
		// from this holder is whatever their matured rate owes (0).
		wA, blkA := build()
		srA, err := Sell(wA.s, "victim", c, blkA, V)
		if err != nil {
			t.Fatal(err)
		}

		// The attack: the creator donates g tokens to re-age the victim.
		wB, blkB := build()
		// The strongest possible cost basis for the donated tokens: their gross
		// curve value at the top of the book right now.
		S := getMoney(wB.s, kSupply(c))
		donationValue, err := SellProceeds(S, g)
		if err != nil {
			t.Fatal(err)
		}
		if err := TransferCredits(wB.s, c, c, "victim", blkB, g); err != nil {
			t.Fatal(err)
		}
		srB, err := Sell(wB.s, "victim", c, blkB, new(big.Int).Add(V, g))
		if err != nil {
			t.Fatal(err)
		}

		extraTax := new(big.Int).Sub(srB.Tax, srA.Tax)
		if extraTax.Sign() < 0 {
			extraTax.SetInt64(0)
		}
		gain := new(big.Int).Div(extraTax, big.NewInt(2)) // accrueExitTax: creator half

		if gain.Cmp(donationValue) >= 0 {
			t.Fatalf("P4b RE-AGING PAYS (iter %d): the creator donated %s tokens worth %s to a %s-token matured "+
				"position and collected %s as their half of the induced tax (rate %d bps on gross %s). "+
				"Re-aging someone else's position is profitable.",
				i, g, donationValue, V, gain, srB.TaxBps, srB.Gross)
		}
		if new(big.Int).Mul(gain, worstRatioDen).Cmp(new(big.Int).Mul(worstRatioNum, donationValue)) > 0 {
			worstRatioNum, worstRatioDen = gain, donationValue
		}
	}
	pct := new(big.Int).Mul(worstRatioNum, big.NewInt(100))
	if worstRatioDen.Sign() > 0 {
		pct.Div(pct, worstRatioDen)
	}
	t.Logf("P4b worst observed: the creator recovers %s%% of the donated tokens' curve value via their tax half", pct)
}

// ---------------------------------------------------------------------------
// P5 MONOTONE
//
// "Holding longer never increases your rate; the rate is non-increasing in held
// time everywhere including both boundaries — and it is the exact ceil of ONE
// affine function across the whole window."
//
// The affine half is the load-bearing premise of the entire merge design: a
// size-weighted average of AGES equals a size-weighted average of RATES only
// because the schedule is affine on [0, window]. A schedule with a step, a
// floor, or a second segment silently invalidates every conservation claim in
// this file, and NOTHING else in the suite would notice.
// ---------------------------------------------------------------------------

func TestP5_Monotone_AndAffineAcrossTheWindow(t *testing.T) {
	// Boundaries, explicitly.
	for _, tc := range []struct {
		h    uint64
		want uint64
	}{
		{0, MaxExitTaxBps},
		{1, MaxExitTaxBps},
		{mpDt - 1, 1},
		{mpDt, 0},
		{mpDt + 1, 0},
		{1 << 62, 0},
	} {
		if got := ExitTaxBpsAt(tc.h); got != tc.want {
			t.Fatalf("boundary: ExitTaxBpsAt(%d) = %d, want %d", tc.h, got, tc.want)
		}
	}

	r := rand.New(rand.NewSource(0x5A0E))
	for i := 0; i < 60000; i++ {
		h := uint64(r.Int63n(int64(4 * mpDt)))
		d := uint64(r.Int63n(int64(mpDt)))
		if ExitTaxBpsAt(h+d) > ExitTaxBpsAt(h) {
			t.Fatalf("P5: rate rose with held time: τ(%d)=%d < τ(%d)=%d",
				h, ExitTaxBpsAt(h), h+d, ExitTaxBpsAt(h+d))
		}
		// AFFINITY on [0, Dt]: 0 <= τ(h)·Dt − MaxExitTaxBps·(Dt−h) < Dt, i.e. τ
		// is exactly ceil of one straight line, seller-adverse by under 1 bps.
		hh := h % (mpDt + 1)
		lhs := new(big.Int).Mul(mpBig(ExitTaxBpsAt(hh)), mpBig(mpDt))
		rhs := new(big.Int).Mul(mpBig(MaxExitTaxBps), mpBig(mpDt-hh))
		res := new(big.Int).Sub(lhs, rhs)
		if res.Sign() < 0 || res.Cmp(mpBig(mpDt)) >= 0 {
			t.Fatalf("P5 AFFINITY BROKEN at held=%d: τ=%d, residue %s not in [0, %d). "+
				"The schedule is no longer the ceil of one straight line — every conservation "+
				"property in this file rests on that and is now unproven.",
				hh, ExitTaxBpsAt(hh), res, mpDt)
		}
	}

	// The premise itself, at exact rationals: for ages inside the window a
	// size-weighted mean of AGES carries a size-weighted mean of RATES.
	//   b_m·L(mean) == b1·L(a1) + b2·L(a2)   with L(a) = Max·(Dt−a)/Dt
	// cross-multiplied by Dt so it is an exact integer identity.
	for i := 0; i < 20000; i++ {
		b1 := big.NewInt(r.Int63n(MaxCap) + 1)
		b2 := big.NewInt(r.Int63n(MaxCap) + 1)
		a1 := uint64(r.Int63n(int64(mpDt) + 1))
		a2 := uint64(r.Int63n(int64(mpDt) + 1))
		bm := new(big.Int).Add(b1, b2)
		// b_m·Max·Dt − Max·(b1·a1 + b2·a2)  ==  b1·Max·(Dt−a1) + b2·Max·(Dt−a2)
		lhs := new(big.Int).Mul(bm, mpBig(mpDt))
		lhs.Sub(lhs, new(big.Int).Add(
			new(big.Int).Mul(b1, mpBig(a1)),
			new(big.Int).Mul(b2, mpBig(a2)),
		))
		lhs.Mul(lhs, mpBig(MaxExitTaxBps))
		rhs := new(big.Int).Add(mpExactCapacityNum(b1, a1), mpExactCapacityNum(b2, a2))
		if lhs.Cmp(rhs) != 0 {
			t.Fatalf("P5 PREMISE: weighted-mean-of-ages != weighted-mean-of-rates (%s vs %s)", lhs, rhs)
		}
	}
}

// ---------------------------------------------------------------------------
// P6 BOUNDED
//
// "No stored clock can represent more age than the decay window at the block it
// is written, none can ever be ahead of the current block, and no read of held
// time ever reports more than the window."
//
// THE FIRST CLAUSE IS DELIBERATELY SCOPED TO THE WRITE, and the scoping is the
// honest part: a clock stored at block B and left alone for a year DOES sit more
// than a window behind the head, and no store-time rule can prevent that without
// a keeper touching every holder. What must never happen is that such a clock is
// USED as a weighted-average input at its face value — which is why every write
// re-clamps against the CURRENT block, and why P2's ledger (recomputed from
// stored state, never through heldBlocksAt) is the property that actually
// enforces it. Asserting the unscoped version here would be a claim this design
// does not earn.
// ---------------------------------------------------------------------------

func TestP6_Bounded_StoredClockWithinWindowAndNotAhead(t *testing.T) {
	r := rand.New(rand.NewSource(0xB0DD))
	holders := []string{"b1", "b2", "b3"}
	const c = "p6creator"

	for run := 0; run < 30; run++ {
		w := mpNewWorld(c, 2_000_000)
		for op := 0; op < 100; op++ {
			switch r.Intn(3) {
			case 0:
				w.block += uint64(r.Int63n(100) + 1)
			default:
				w.block += mpDt + uint64(r.Int63n(int64(3*mpDt)))
			}
			h := holders[r.Intn(len(holders))]
			bal := getMoney(w.s, kBal(c, h))
			var touched []string
			if bal.Sign() == 0 || r.Intn(2) == 0 {
				if _, err := Buy(w.s, h, c, w.block, big.NewInt(r.Int63n(400)+1)); err != nil {
					t.Fatalf("run %d op %d: %v", run, op, err)
				}
				touched = []string{h}
			} else {
				to := holders[r.Intn(len(holders))]
				if to == h {
					continue
				}
				amt := new(big.Int).Add(big.NewInt(1), new(big.Int).Rand(r, bal))
				if amt.Cmp(bal) > 0 {
					amt.Set(bal)
				}
				if err := TransferCredits(w.s, c, h, to, w.block, amt); err != nil {
					t.Fatalf("run %d op %d: %v", run, op, err)
				}
				touched = []string{to}
			}

			// (a) NO CLOCK IS EVER AHEAD OF THE BLOCK — every holder, always.
			for _, hh := range holders {
				acq := getU64(w.s, kAcqBlock(c, hh))
				if acq > w.block {
					t.Fatalf("P6 (run %d op %d): %s's clock %d is AHEAD of block %d", run, op, hh, acq, w.block)
				}
			}
			// (b) A CLOCK JUST WRITTEN REPRESENTS AT MOST ONE WINDOW OF AGE.
			for _, hh := range touched {
				acq := getU64(w.s, kAcqBlock(c, hh))
				if acq == 0 {
					continue // unset == fresh, holdclock.go's convention
				}
				if w.block-acq > mpDt {
					t.Fatalf("P6 UNBOUNDED (run %d op %d): %s's clock was written at block %d and already represents "+
						"%d blocks of age; the decay window is %d. A stored age past the window is banked laundering "+
						"capacity: it survives the next weighted average and swallows the next inflow's tax.",
						run, op, hh, w.block, w.block-acq, mpDt)
				}
			}
			// (c) READ SIDE: no query ever reports more held time than the window.
			for _, q := range []uint64{w.block, w.block + mpDt, w.block + 100*mpDt} {
				for _, hh := range holders {
					if got := heldBlocksAt(w.s, c, hh, q); got > mpDt {
						t.Fatalf("P6 READ (run %d op %d): heldBlocksAt(%s, %d) = %d > window %d",
							run, op, hh, q, got, mpDt)
					}
				}
			}
		}
	}
}

// ---------------------------------------------------------------------------
// P7 INFALLIBLE (RULING G) — not one of the six, but the invariant the other six
// must not be allowed to break. creditInflow / creditInflowAt sit on EVERY fund
// path and may never reject; they return no error, so the only ways to violate
// the rule are a panic or a wrong balance. Both are asserted here across the
// degenerate corners a clamp is most likely to break: block 0, block 1, blocks
// below the decay window (where `block − window` underflows if written
// carelessly), clocks ahead of the block, and unset clocks.
// ---------------------------------------------------------------------------

func TestP7_Infallible_CreditInflowNeverPanicsAndIsExact(t *testing.T) {
	const c = "p7creator"
	blocks := []uint64{0, 1, 2, mpDt - 1, mpDt, mpDt + 1, 10 * mpDt, 1 << 40}
	acqs := []uint64{0, 1, mpDt, 1 << 40, 1<<40 + 1, 1 << 62}
	bals := []*big.Int{big.NewInt(0), big.NewInt(1), big.NewInt(MaxCap)}
	amts := []*big.Int{big.NewInt(1), big.NewInt(7), big.NewInt(MaxCap)}

	for _, blk := range blocks {
		for _, acq := range acqs {
			for _, pre := range bals {
				for _, n := range amts {
					func() {
						defer func() {
							if rec := recover(); rec != nil {
								t.Fatalf("P7: creditInflowAt PANICKED (block=%d acq=%d pre=%s n=%s): %v — "+
									"an infallible helper on every fund path must never trap", blk, acq, pre, n, rec)
							}
						}()
						s := NewMemStore()
						if pre.Sign() > 0 {
							// A pre-existing CLOCKED balance, established the
							// honest way wherever the block allows it.
							creditInflow(s, c, "h", pre, blk)
						}
						before := getMoney(s, kBal(c, "h"))
						creditInflowAt(s, c, "h", n, acq, blk)
						want := new(big.Int).Add(before, n)
						if got := getMoney(s, kBal(c, "h")); got.Cmp(want) != 0 {
							t.Fatalf("P7: balance %s, want %s (block=%d acq=%d n=%s)", got, want, blk, acq, n)
						}
						if w := getU64(s, kAcqBlock(c, "h")); w > blk {
							t.Fatalf("P7/C-13: stored clock %d ahead of block %d (acq=%d)", w, blk, acq)
						}
					}()
				}
			}
		}
	}

	// And the outflows must stay open at any clock: an exit is never rejected
	// because of maturity (RULING G — no outflow may revert on an aggregate).
	r := rand.New(rand.NewSource(0x1FA11))
	for i := 0; i < 200; i++ {
		w := mpNewWorld("p7market", 9_000_000)
		n := big.NewInt(r.Int63n(5000) + 1)
		if _, err := Buy(w.s, "h", "p7market", w.block, n); err != nil {
			t.Fatal(err)
		}
		sellBlock := w.block + mpRandAge(r)
		if _, err := Sell(w.s, "h", "p7market", sellBlock, n); err != nil {
			t.Fatalf("P7: Sell rejected at held=%d: %v", sellBlock-w.block, err)
		}
	}
}
