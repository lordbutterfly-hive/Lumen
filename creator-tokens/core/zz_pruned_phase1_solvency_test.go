//go:build pruned_findings

// ════ AUDIT FINDING-DETECTOR, NOT A UNIT TEST ════
//
// This file FAILS ON PURPOSE. Each test asserts the ABSENCE of a defect the PRUNED audit
// of 2026-08-19 proved is PRESENT, so a failure here is the finding reproducing itself,
// not a regression.
//
// ★ IT IS BEHIND A BUILD TAG SO THE DEFAULT SUITE STAYS GREEN. Left untagged, `go test
// ./...` was red for reasons that are all known and documented - which destroys the one
// thing a suite is for: telling you when something NEW broke. A permanently-red suite is
// a suite nobody reads.
//
//   run the detectors:  go test -tags pruned_findings ./...
//   run the real suite: go test ./...
//
// When a finding is FIXED, its detector here starts passing. That is the intended signal:
// delete the test then, or move it into the real suite as a regression guard.
//
// Findings, artifacts and twins: /mnt/o/LUMEN-DOCS/audits/creator-tokens/2026-08-19/

package core

// ===========================================================================
// zz_pruned_phase1_solvency_test.go — PRUNED PHASE 1 (VALUE / ACCOUNTING).
//
// OWNS: H-10 (the FOURTH resting bucket), core INV-1, INV-2, INV-4, INV-5,
// and the "is there a FIFTH bucket" question that H-10 only implies.
//
// METHOD. Every check here sweeps the WHOLE STORE by key and classifies each
// key it finds — it never asks a fixed actor list what it holds. That is the
// deliberate difference from fuzz_test.go's own solvency check, whose
// weakness the Phase-0 model names explicitly ("Asserted in fuzz_test.go
// :980-987 over a FIXED actor list"): a fixed list can only ever confirm the
// buckets the author already thought of, and H-10 is precisely a claim about
// a bucket nobody thought of.
//
// Every `zp1` name is local to this file (the package already carries `fz`,
// `hz`, and five other authors' helpers).
// ===========================================================================

import (
	"fmt"
	"math/big"
	"math/rand"
	"sort"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// THE SWEEP — classify every key in the store, refuse to ignore anything.
// ---------------------------------------------------------------------------

// zp1MFields is the complete set of `m|<creator>|<field>` tags this package
// writes, pinned here so a NEW field family cannot appear without this test
// failing. The three HBD-bearing ones are marked; everything else is a block
// height, a token count, a state string, or a POSTED PRICE (a price is not a
// balance — no HBD rests in it).
var zp1MFields = map[string]string{
	"face": "price", "fsa": "block", "fan": "price", "faa": "block",
	"cap": "tokens", "sup": "tokens", "res": "HBD-RESERVE", "pu": "block",
	"st": "state", "reg": "block", "seq": "counter", "rat": "block",
	"dmc": "counter", "ddc": "counter", "ddu": "block", "dou": "block",
	"oep": "counter", "rsum": "counter", "rcnt": "counter",
	// The anti-ratchet pair (F10 fix, 2026-08-19). Neither holds value: "dcs"
	// counts convictions inside a cooldown and "dce" is the block the last
	// sentence ended, both purely inputs to the repeat-conviction miss floor.
	"dcs": "counter", "dce": "block",
}

type zp1Buckets struct {
	Reserve      *big.Int // Σ m|<c>|res
	Treasury     *big.Int // the bare "treasury" key
	FeePots      *big.Int // Σ fee|<account>  (STORE-WIDE, not "for each creator")
	EscrowPend   *big.Int // Σ field-5 of PENDING escrow records — THE FOURTH BUCKET
	EscrowAll    *big.Int // Σ field-5 of EVERY escrow record, whatever its status
	NPendEscrows int
	Unknown      []string // any key whose shape this test does not recognise
	Shapes       map[string]int
}

func zp1NewBuckets() *zp1Buckets {
	return &zp1Buckets{
		Reserve: big.NewInt(0), Treasury: big.NewInt(0), FeePots: big.NewInt(0),
		EscrowPend: big.NewInt(0), EscrowAll: big.NewInt(0),
		Shapes: map[string]int{},
	}
}

// Three returns reserve + treasury + feePots — the sum an accounting pass that
// forgets the escrow leg would compute. This is the sum H-10 says is short.
func (b *zp1Buckets) Three() *big.Int {
	t := new(big.Int).Add(b.Reserve, b.Treasury)
	return t.Add(t, b.FeePots)
}

// Four adds the held escrow commission.
func (b *zp1Buckets) Four() *big.Int {
	return new(big.Int).Add(b.Three(), b.EscrowPend)
}

func zp1Sweep(t *testing.T, s *MemStore) *zp1Buckets {
	t.Helper()
	b := zp1NewBuckets()
	keys := s.Keys()
	sort.Strings(keys)
	for _, k := range keys {
		v, _ := s.Get(k)
		p := strings.Split(k, "|")
		switch {
		case k == "treasury":
			b.Shapes["treasury"]++
			b.Treasury.Add(b.Treasury, getMoney(s, k))
		case k == "owner" || k == "paused":
			b.Shapes[k]++
		case p[0] == "fee" && len(p) == 2:
			b.Shapes["fee|*"]++
			b.FeePots.Add(b.FeePots, getMoney(s, k))
		case p[0] == "m" && len(p) >= 4 && p[2] == "o":
			// m|<c>|o|<epoch>|<id>|<field...> — the offering catalogue.
			b.Shapes["m|*|o|*|*|"+strings.Join(p[5:], "|")]++
		case p[0] == "m" && len(p) == 3:
			f := p[2]
			if _, ok := zp1MFields[f]; !ok {
				b.Unknown = append(b.Unknown, k+"  (unrecognised m| field tag "+f+")")
				continue
			}
			b.Shapes["m|*|"+f]++
			if f == "res" {
				b.Reserve.Add(b.Reserve, getMoney(s, k))
			}
		case p[0] == "e" && len(p) == 3:
			b.Shapes["e|*|*"]++
			rec, ok := unpackEscrow(v)
			if !ok {
				b.Unknown = append(b.Unknown, k+"  (escrow record failed to unpack)")
				continue
			}
			b.EscrowAll.Add(b.EscrowAll, rec.commissionHbd)
			if rec.status == askPending {
				b.NPendEscrows++
				b.EscrowPend.Add(b.EscrowPend, rec.commissionHbd)
			}
		case p[0] == "em" && len(p) == 3:
			// em|<creator>|<seq> — the MATURED-bucket portion of one escrow's
			// draw (F2/F17 fix, 2026-08-19). It holds NO independent value: the
			// escrow's whole credit amount is already accounted for by the
			// e|<c>|<seq> record above, and this key only says which SUBSET of
			// that same amount must return to the matured bucket. Counting it
			// as a bucket would double-count the escrow.
			b.Shapes["em|*|*"]++
		case p[0] == "mb" && len(p) == 3:
			b.Shapes["mb|*|*"]++
		case p[0] == "bal" && len(p) == 3:
			b.Shapes["bal|*|*"]++
		case p[0] == "allow" && len(p) == 4:
			b.Shapes["allow|*|*|*"]++
		case p[0] == "acq" && len(p) == 3:
			b.Shapes["acq|*|*"]++
		case p[0] == "r" && len(p) == 3:
			b.Shapes["r|*|*"]++
		case (p[0] == "tw" || p[0] == "twl") && len(p) == 3:
			b.Shapes[p[0]+"|*|*"]++
		default:
			b.Unknown = append(b.Unknown, k+"  (unrecognised key shape)")
		}
	}
	if len(b.Unknown) > 0 {
		t.Fatalf("STORE SWEEP found key shapes this accounting model does not know — "+
			"an unclassified key family is exactly how a resting bucket hides:\n  %s",
			strings.Join(b.Unknown, "\n  "))
	}
	return b
}

// zp1SumTokens sweeps the two token families store-wide for one creator.
// Deliberately NOT "for each holder in a list".
func zp1SumTokens(s *MemStore, creator string) (maturing, matured, escrowed *big.Int, holders int) {
	maturing, matured, escrowed = big.NewInt(0), big.NewInt(0), big.NewInt(0)
	mbPrefix := "mb|" + creator + "|"
	balSuffix := "|" + creator
	escPrefix := "e|" + creator + "|"
	seen := map[string]bool{}
	for _, k := range s.Keys() {
		v, _ := s.Get(k)
		switch {
		case strings.HasPrefix(k, mbPrefix):
			n, ok := new(big.Int).SetString(v, 10)
			if ok {
				maturing.Add(maturing, n)
			}
			seen[strings.TrimPrefix(k, mbPrefix)] = true
		case strings.HasPrefix(k, "bal|") && strings.HasSuffix(k, balSuffix):
			n, ok := leToU64([]byte(v))
			if ok {
				matured.Add(matured, new(big.Int).SetUint64(n))
			}
			h := strings.TrimSuffix(strings.TrimPrefix(k, "bal|"), balSuffix)
			seen[h] = true
		case strings.HasPrefix(k, escPrefix):
			rec, ok := unpackEscrow(v)
			if ok && rec.status == askPending {
				escrowed.Add(escrowed, rec.credits)
			}
		}
	}
	return maturing, matured, escrowed, len(seen)
}

// ---------------------------------------------------------------------------
// THE WALK — a randomized adversarial op sequence over the whole public API.
// ---------------------------------------------------------------------------

type zp1World struct {
	s        *MemStore
	block    uint64
	in       *big.Int // every HBD base unit the wrapper would DRAW into the contract
	out      *big.Int // every HBD base unit the wrapper would TRANSFER out
	creators []string
	actors   []string
	cov      map[string]int
	// windDownSeen[c] records that this incarnation has taken a wind-down
	// payout, after which INV-2 relaxes from equality to >=.
	windDownSeen map[string]bool
	pend         []zp1Esc
	log          []string
}

type zp1Esc struct {
	creator string
	seq     uint64
	asker   string
}

func (w *zp1World) hit(k string)            { w.cov[k]++ }
func (w *zp1World) paid(v *big.Int)         { w.in.Add(w.in, v) }
func (w *zp1World) got(v *big.Int)          { w.out.Add(w.out, v) }
func (w *zp1World) note(f string, a ...any) { w.log = append(w.log, fmt.Sprintf(f, a...)) }
func (w *zp1World) tail(n int) string {
	if len(w.log) > n {
		return strings.Join(w.log[len(w.log)-n:], "\n  ")
	}
	return strings.Join(w.log, "\n  ")
}

const zp1Owner = "zp1owner"

func zp1NewWorld(seed int64) *zp1World {
	s := NewMemStore()
	setStr(s, kOwner(), zp1Owner)
	w := &zp1World{
		s: s, block: 1, in: big.NewInt(0), out: big.NewInt(0),
		creators:     []string{"zp1c1", "zp1c2", "zp1c3"},
		actors:       []string{"zp1h1", "zp1h2", "zp1h3", "zp1c1", "zp1c2", zp1Owner},
		cov:          map[string]int{},
		windDownSeen: map[string]bool{},
	}
	return w
}

// zp1Amt is boundary-biased: 1 and 2 are as likely as a big number, because
// every rounding bug this file hunts lives at the small end.
func zp1Amt(rng *rand.Rand) *big.Int {
	switch rng.Intn(8) {
	case 0:
		return big.NewInt(1)
	case 1:
		return big.NewInt(2)
	case 2:
		return big.NewInt(3)
	case 3:
		return big.NewInt(int64(1 + rng.Intn(9)))
	case 4:
		return big.NewInt(int64(1 + rng.Intn(97)))
	case 5:
		return big.NewInt(int64(1 + rng.Intn(1009)))
	case 6:
		return big.NewInt(int64(1 + rng.Intn(100003)))
	default:
		return big.NewInt(int64(1 + rng.Intn(50)))
	}
}

// zp1SeedObs writes a spanning observation history so Ask can actually settle.
// Without it SettlementRate refuses on the long ring's minimum count and every
// Ask in the walk returns an error — which would make the H-10 arm VACUOUS.
func zp1SeedObs(s Store, creator string, base uint64) uint64 {
	for i := uint64(0); i < ObsWindow; i++ {
		setStr(s, kObs(creator, i), "")
		setStr(s, kObsLong(creator, i), "")
	}
	setU64(s, kObsIdx(creator), 0)
	setU64(s, kObsLongIdx(creator), 0)
	rate := SpotRate(getMoney(s, kSupply(creator)))
	if rate.Sign() <= 0 {
		rate = big.NewInt(int64(BasePrice))
	}
	for i := uint64(0); i < stObsCount; i++ {
		RecordObs(s, creator, base+i*LongObsSpacing, rate)
	}
	return base + (stObsCount-1)*LongObsSpacing + 50
}

// zp1Ops is the WEIGHTED op table. The weights are not cosmetic: an unweighted
// uniform draw over 18 branches produced Retire 256 successes against Sell 82
// and Reclaim 2, i.e. the walk spent its time in wind-down and barely touched
// the escrow lifecycle H-10 is about. These weights were tuned against the
// printed coverage table until every arm fires in the hundreds.
var zp1Ops = []int{
	0,
	1, 1,
	2, 2, 2, 2, 2, 2,
	5, 5, 5, 5, 5, 5, 5, 5,
	7, 7, 7, 7, 7, 7,
	8, 8, 8, 8,
	9, 9, 9, 9,
	10, 10, 10, 10,
	11, 11,
	12, 12,
	13,
	14, 14, 14,
	15, 15, 15,
	16, 16, 16,
	17, 17, 17, 17, 17, 17,
}

// zp1Step performs ONE random operation and books its HBD legs.
func zp1Step(t *testing.T, rng *rand.Rand, w *zp1World) {
	c := w.creators[rng.Intn(len(w.creators))]
	a := w.actors[rng.Intn(len(w.actors))]

	switch zp1Ops[rng.Intn(len(zp1Ops))] {

	case 0: // Register
		face := int64(MinFace + int64(rng.Intn(20000)))
		capN := int64(1 + rng.Intn(2_000_000))
		if err := Register(w.s, c, c, w.block, face, capN); err == nil {
			w.hit("Register")
			w.windDownSeen[c] = false // a NEW incarnation is back at the equality form
			w.note("Register(%s, face=%d cap=%d) @%d", c, face, capN, w.block)
		}

	case 1: // Renew — HBD IN, booked wholly to the treasury
		periods := uint64(1 + rng.Intn(3))
		paid := new(big.Int).Mul(big.NewInt(int64(periods)), big.NewInt(SubscriptionFee))
		if rng.Intn(4) == 0 { // adversarial over-payment (a donation, per A-18)
			paid.Add(paid, big.NewInt(int64(rng.Intn(5000))))
		}
		if err := Renew(w.s, a, c, w.block, periods, paid); err == nil {
			w.hit("Renew")
			w.paid(paid)
			w.note("Renew(%s by %s, %d periods, paid=%s) @%d", c, a, periods, paid, w.block)
		}

	case 2, 3, 4: // Buy — HBD IN
		n := zp1Amt(rng)
		if r, err := Buy(w.s, a, c, w.block, n); err == nil {
			w.hit("Buy")
			w.paid(r.TotalDue)
			w.note("Buy(%s->%s, n=%s) due=%s @%d", a, c, n, r.TotalDue, w.block)
			zp1AssertExitSplit(t, w, "Buy", nil)
		}

	case 5, 6: // Sell — HBD OUT
		bal := totalBalance(w.s, c, a)
		if bal.Sign() == 0 {
			return
		}
		amt := zp1Amt(rng)
		if amt.Cmp(bal) > 0 {
			amt = bal
		}
		resBefore := getMoney(w.s, kReserve(c))
		if r, err := Sell(w.s, a, c, w.block, amt); err == nil {
			w.hit("Sell")
			w.got(r.Net)
			// INV-5 — the split equality, per exit.
			sum := new(big.Int).Add(r.Net, r.Tax)
			sum.Add(sum, r.FeeCreator)
			sum.Add(sum, r.FeePlatform)
			if sum.Cmp(r.Gross) != 0 {
				t.Fatalf("INV-5 VIOLATED on Sell: gross=%s but net+tax+feeC+feeP=%s\n  %s",
					r.Gross, sum, w.tail(20))
			}
			if r.Net.Sign() < 0 {
				t.Fatalf("INV-5 VIOLATED on Sell: net=%s < 0\n  %s", r.Net, w.tail(20))
			}
			if r.Fee.Cmp(new(big.Int).Add(r.FeeCreator, r.FeePlatform)) != 0 {
				t.Fatalf("INV-5 VIOLATED on Sell: fee=%s != feeC+feeP\n  %s", r.Fee, w.tail(20))
			}
			// INV-4 — ΔReserve is EXACTLY the curve leg, never the tax or the fee.
			resAfter := getMoney(w.s, kReserve(c))
			want := new(big.Int).Sub(resBefore, r.Gross)
			if resAfter.Cmp(want) != 0 {
				t.Fatalf("INV-4 VIOLATED on Sell: reserve %s -> %s, expected %s (=before-gross)\n  %s",
					resBefore, resAfter, want, w.tail(20))
			}
			w.note("Sell(%s of %s, n=%s) gross=%s tax=%s net=%s @%d", a, c, amt, r.Gross, r.Tax, r.Net, w.block)
		}

	case 7: // Ask — HBD IN (the commission leg), held INSIDE the escrow record
		// REACHABILITY SCAFFOLD, stated plainly so nobody mistakes it for the
		// system under test. Ask prices off the TWAP rings and off the stored
		// face; a random walk almost never lands on a (ring, supply, face)
		// triple that settles, so without this the arm is 100% rejections and
		// the FOURTH BUCKET is never non-empty — i.e. a vacuous H-10 test.
		// None of these writes moves HBD: an observation is a rate, kFace is a
		// posted PRICE, kPaidUntil is a block height. The money identity under
		// test is untouched by all three.
		if _, err := SettlementRate(w.s, c, w.block); err != nil {
			w.block = zp1SeedObs(w.s, c, w.block)
		}
		// The subscription top-up goes through the PRODUCTION Renew, never a
		// raw setU64 on kPaidUntil. THIS MATTERS AND IT WAS MEASURED: the first
		// version of this scaffold wrote kPaidUntil directly, which revived a
		// FROZEN market that had already taken wind-down pro-rata payouts. The
		// walk then found `supply == 0 && reserve == 15321` within 90 steps —
		// a stranded, buyable, unallocated reserve. That is NOT a defect in the
		// contract: Renew routes through requireMarketAcceptsMoney and REFUSES
		// in FROZEN/CLOSED (market.go:762 doc + :402), and registerCheck
		// (market.go:520) refuses to re-register over a non-zero reserve. The
		// harness had simply forged an unreachable state. Recorded here rather
		// than deleted, because it is direct evidence that BOTH of those two
		// guards are load-bearing: remove either one and the walk reproduces
		// the unallocated pot in under a hundred operations.
		if getU64(w.s, kPaidUntil(c)) <= w.block {
			paid := big.NewInt(SubscriptionFee)
			if err := Renew(w.s, c, c, w.block, 1, paid); err != nil {
				return
			}
			w.hit("Renew")
			w.paid(paid)
			w.note("Renew(%s, scaffold) @%d", c, w.block)
		}
		lo, hi, ferr := ServiceFaceRange(w.s, c, w.block)
		if ferr != nil {
			return
		}
		face := lo
		if hi.Cmp(lo) > 0 && rng.Intn(2) == 0 {
			span := new(big.Int).Sub(hi, lo)
			if span.IsInt64() && span.Int64() > 0 {
				face = new(big.Int).Add(lo, big.NewInt(rng.Int63n(span.Int64()+1)))
			}
		}
		setMoney(w.s, kFace(c), face)
		q, err := SettleSpend(w.s, c, w.block, face)
		if err != nil {
			return
		}
		commission := q.CommissionHbd
		maxCredits := new(big.Int).Mul(q.Credits, big.NewInt(4))
		dl := MinAskDeadline + uint64(rng.Intn(int(MaxAskDeadline-MinAskDeadline)))
		r, err := Ask(w.s, a, c, w.block, maxCredits, commission, fmt.Sprintf("cid%d-%d", w.block, rng.Int63()), dl, 0)
		if err == nil {
			w.hit("Ask")
			if commission.Sign() > 0 {
				w.hit("Ask-with-commission")
			}
			w.paid(commission)
			w.pend = append(w.pend, zp1Esc{creator: c, seq: r.Seq, asker: a})
			w.note("Ask(%s->%s seq=%d credits=%s commission=%s) @%d", a, c, r.Seq, r.CreditsSpent, commission, w.block)
		}

	case 8: // Answer — the held commission moves escrow -> treasury. NO HBD leg.
		if len(w.pend) == 0 {
			return
		}
		i := rng.Intn(len(w.pend))
		e := w.pend[i]
		if _, err := Answer(w.s, e.creator, e.creator, w.block, e.seq, fmt.Sprintf("ans%d", rng.Int63())); err == nil {
			w.hit("Answer")
			w.pend = append(w.pend[:i], w.pend[i+1:]...)
			w.note("Answer(%s seq=%d) @%d", e.creator, e.seq, w.block)
		}

	case 9: // Reclaim — HBD OUT (commission returned net of the miss slice)
		if len(w.pend) == 0 {
			return
		}
		i := rng.Intn(len(w.pend))
		e := w.pend[i]
		if r, err := Reclaim(w.s, a, e.creator, w.block, e.seq); err == nil {
			w.hit("Reclaim")
			w.got(r.CommissionHbd)
			w.pend = append(w.pend[:i], w.pend[i+1:]...)
			w.note("Reclaim(%s seq=%d) returned=%s retained=%s @%d", e.creator, e.seq, r.CommissionHbd, r.CommissionRetainedHbd, w.block)
		}

	case 10: // Decline — HBD OUT (full commission returned)
		if len(w.pend) == 0 {
			return
		}
		i := rng.Intn(len(w.pend))
		e := w.pend[i]
		if r, err := Decline(w.s, e.creator, e.creator, w.block, e.seq); err == nil {
			w.hit("Decline")
			w.got(r.CommissionHbd)
			w.pend = append(w.pend[:i], w.pend[i+1:]...)
			w.note("Decline(%s seq=%d) returned=%s @%d", e.creator, e.seq, r.CommissionHbd, w.block)
		}

	case 11: // ClaimTradeFees — HBD OUT
		if owed, err := ClaimTradeFees(w.s, a); err == nil && owed.Sign() > 0 {
			w.hit("ClaimTradeFees")
			w.got(owed)
			w.note("ClaimTradeFees(%s)=%s @%d", a, owed, w.block)
		}

	case 12: // WithdrawTreasury — HBD OUT
		bal := getMoney(w.s, kTreasury())
		if bal.Sign() == 0 {
			return
		}
		amt := new(big.Int).Div(bal, big.NewInt(int64(1+rng.Intn(3))))
		if amt.Sign() == 0 {
			amt = big.NewInt(1)
		}
		if got, err := WithdrawTreasury(w.s, zp1Owner, amt); err == nil {
			w.hit("WithdrawTreasury")
			w.got(got)
			w.note("WithdrawTreasury(%s) @%d", got, w.block)
		}

	case 13: // Retire — opens the wind-down rail
		if err := Retire(w.s, c, c, w.block); err == nil {
			w.hit("Retire")
			w.note("Retire(%s) @%d", c, w.block)
		}

	case 14: // Refund (pull) — HBD OUT
		bal := totalBalance(w.s, c, a)
		if bal.Sign() == 0 {
			return
		}
		amt := zp1Amt(rng)
		if amt.Cmp(bal) > 0 {
			amt = bal
		}
		resBefore := getMoney(w.s, kReserve(c))
		supBefore := getMoney(w.s, kSupply(c))
		grossWant := refundPayout(resBefore, amt, supBefore)
		if net, err := Refund(w.s, a, c, w.block, amt); err == nil {
			w.hit("Refund")
			w.got(net)
			w.windDownSeen[c] = true
			resAfter := getMoney(w.s, kReserve(c))
			if want := new(big.Int).Sub(resBefore, grossWant); resAfter.Cmp(want) != 0 {
				t.Fatalf("INV-4 VIOLATED on Refund: reserve %s -> %s, expected %s\n  %s",
					resBefore, resAfter, want, w.tail(20))
			}
			if net.Cmp(grossWant) > 0 {
				t.Fatalf("INV-5 VIOLATED on Refund: net=%s exceeds gross=%s\n  %s", net, grossWant, w.tail(20))
			}
			w.note("Refund(%s of %s, credits=%s) gross=%s net=%s @%d", a, c, amt, grossWant, net, w.block)
		}

	case 15: // RefundHolder (permissionless push) — HBD OUT
		h := w.actors[rng.Intn(len(w.actors))]
		resBefore := getMoney(w.s, kReserve(c))
		supBefore := getMoney(w.s, kSupply(c))
		balH := totalBalance(w.s, c, h)
		grossWant := big.NewInt(0)
		if supBefore.Sign() > 0 {
			grossWant = refundPayout(resBefore, balH, supBefore)
		}
		if net, err := RefundHolder(w.s, a, c, h, w.block); err == nil && net.Sign() > 0 {
			w.hit("RefundHolder")
			w.got(net)
			w.windDownSeen[c] = true
			resAfter := getMoney(w.s, kReserve(c))
			if want := new(big.Int).Sub(resBefore, grossWant); resAfter.Cmp(want) != 0 {
				t.Fatalf("INV-4 VIOLATED on RefundHolder: reserve %s -> %s, expected %s\n  %s",
					resBefore, resAfter, want, w.tail(20))
			}
			w.note("RefundHolder(%s of %s) gross=%s net=%s @%d", h, c, grossWant, net, w.block)
		}

	case 16: // token-only ops: transfer / graduate / setface / setcap / close
		switch rng.Intn(5) {
		case 0:
			to := w.actors[rng.Intn(len(w.actors))]
			bal := getMoney(w.s, kBal(c, a))
			amt := zp1Amt(rng)
			if amt.Cmp(bal) > 0 {
				amt = bal
			}
			if amt.Sign() > 0 && to != a {
				if err := TransferCredits(w.s, a, c, a, to, w.block, amt); err == nil {
					w.hit("TransferCredits")
				}
			}
		case 1:
			if n := Graduate(w.s, c, a, w.block); n.Sign() > 0 {
				w.hit("Graduate")
			}
		case 2:
			if err := SetFace(w.s, c, c, w.block, MinFace+int64(rng.Intn(20000))); err == nil {
				w.hit("SetFace")
			}
		case 3:
			if err := SetCap(w.s, c, c, w.block, int64(1+rng.Intn(2_000_000))); err == nil {
				w.hit("SetCap")
			}
		case 4:
			if CloseIfDrained(w.s, c, w.block) {
				w.hit("CloseIfDrained")
			}
		}

	case 17: // advance the block — boundary-biased around the decay window
		switch rng.Intn(6) {
		case 0:
			w.block += 1
		case 1:
			w.block += uint64(1 + rng.Intn(1000))
		case 2:
			w.block += LongObsSpacing + uint64(rng.Intn(100))
		case 3:
			w.block += BlocksPerDay * uint64(1+rng.Intn(9))
		case 4:
			w.block += ExitTaxDecayBlocks + uint64(rng.Intn(100))
		default:
			w.block += ExitTaxDecayBlocks - uint64(rng.Intn(100)+1)
		}
		if rng.Intn(3) == 0 {
			zp1SeedObs(w.s, w.creators[rng.Intn(len(w.creators))], w.block)
			w.block += 10
		}
	}
}

// zp1AssertExitSplit is a placeholder hook kept so the Buy arm reads the same
// as the exits; it intentionally does nothing (Buy has no exit split).
func zp1AssertExitSplit(t *testing.T, w *zp1World, op string, r *SellResult) {}

// ---------------------------------------------------------------------------
// TEST 1 — H-10: the four-bucket global identity, measured both ways.
// ---------------------------------------------------------------------------

func TestZP1_H10_FourBucketSolvency_RandomWalk(t *testing.T) {
	const (
		seeds = 60
		steps = 1500
	)
	totalCov := map[string]int{}
	maxShortfall := big.NewInt(0)
	var shortfallSeed int64
	shortfallObserved := 0
	pendObserved := 0

	for seed := int64(1); seed <= seeds; seed++ {
		rng := rand.New(rand.NewSource(seed))
		w := zp1NewWorld(seed)
		// Bootstrap so the walk is not all rejections.
		for _, c := range w.creators {
			_ = Register(w.s, c, c, w.block, MinFace+5000, 5_000_000)
		}
		for i := 0; i < steps; i++ {
			zp1Step(t, rng, w)

			b := zp1Sweep(t, w.s)

			// ---- THE FOUR-TERM IDENTITY (H-10's own arithmetic) ----
			netIn := new(big.Int).Sub(w.in, w.out)
			if b.Four().Cmp(netIn) != 0 {
				t.Fatalf("seed %d step %d: FOUR-BUCKET IDENTITY VIOLATED\n"+
					"  in=%s out=%s  net=%s\n"+
					"  reserve=%s treasury=%s feePots=%s escrowPending=%s  four=%s\n"+
					"  delta = four - net = %s\nlast ops:\n  %s",
					seed, i, w.in, w.out, netIn,
					b.Reserve, b.Treasury, b.FeePots, b.EscrowPend, b.Four(),
					new(big.Int).Sub(b.Four(), netIn), w.tail(25))
			}

			// ---- THE THREE-TERM SUM: measure the exposure, do not assert it ----
			short := new(big.Int).Sub(netIn, b.Three())
			if short.Sign() != 0 {
				shortfallObserved++
				if short.Cmp(maxShortfall) > 0 {
					maxShortfall.Set(short)
					shortfallSeed = seed
				}
				// The shortfall must be EXACTLY the pending escrow commission —
				// if it is anything else, the fourth bucket is not the whole story.
				if short.Cmp(b.EscrowPend) != 0 {
					t.Fatalf("seed %d step %d: three-term shortfall %s != pending escrow commission %s "+
						"— there is a FIFTH unaccounted bucket\nlast ops:\n  %s",
						seed, i, short, b.EscrowPend, w.tail(25))
				}
			}
			if b.NPendEscrows > 0 {
				pendObserved++
			}

			// ---- INV-1: supply == Σ maturing + Σ matured + Σ escrowed, store-wide ----
			for _, c := range w.creators {
				sup := getMoney(w.s, kSupply(c))
				mg, md, esc, _ := zp1SumTokens(w.s, c)
				tot := new(big.Int).Add(mg, md)
				tot.Add(tot, esc)
				if sup.Cmp(tot) != 0 {
					t.Fatalf("seed %d step %d: INV-1 VIOLATED for %s — supply=%s, maturing=%s matured=%s escrowed=%s sum=%s\nlast ops:\n  %s",
						seed, i, c, sup, mg, md, esc, tot, w.tail(25))
				}
				// ---- INV-2 ----
				res := getMoney(w.s, kReserve(c))
				area := Area(sup)
				if res.Cmp(area) < 0 {
					t.Fatalf("seed %d step %d: INV-2 VIOLATED for %s — reserve=%s < area(supply=%s)=%s\nlast ops:\n  %s",
						seed, i, c, res, sup, area, w.tail(25))
				}
				if !w.windDownSeen[c] && res.Cmp(area) != 0 {
					t.Fatalf("seed %d step %d: INV-2 EQUALITY VIOLATED for %s (no wind-down payout yet) — reserve=%s != area(%s)=%s\nlast ops:\n  %s",
						seed, i, c, res, sup, area, w.tail(25))
				}
				// ---- stranded reserve: supply drained but HBD left behind ----
				if sup.Sign() == 0 && res.Sign() != 0 {
					t.Fatalf("seed %d step %d: STRANDED RESERVE for %s — supply=0 but reserve=%s (unreachable HBD)\nlast ops:\n  %s",
						seed, i, c, res, w.tail(25))
				}
			}
		}
		for k, v := range w.cov {
			totalCov[k] += v
		}
	}

	// ---- ANTI-VACUITY GATE ----
	// A pass here means nothing unless the walk actually reached the paths
	// under test. Every one of these must have fired.
	must := []string{"Buy", "Sell", "Ask", "Ask-with-commission", "Answer", "Reclaim",
		"Decline", "ClaimTradeFees", "WithdrawTreasury", "Retire", "Refund",
		"RefundHolder", "Renew", "Graduate", "TransferCredits"}
	var missing []string
	for _, k := range must {
		if totalCov[k] == 0 {
			missing = append(missing, k)
		}
	}
	if len(missing) > 0 {
		t.Fatalf("VACUOUS RUN — these paths were never exercised, so their invariants were never tested: %v\ncoverage: %v",
			missing, totalCov)
	}
	if pendObserved == 0 {
		t.Fatalf("VACUOUS RUN — no PENDING escrow ever existed at a checkpoint, so the fourth bucket was never non-empty")
	}
	keys := make([]string, 0, len(totalCov))
	for k := range totalCov {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var cov strings.Builder
	for _, k := range keys {
		fmt.Fprintf(&cov, "    %-20s %d\n", k, totalCov[k])
	}
	t.Logf("SEARCH SPACE: %d seeds x %d ops = %d operations over 3 markets / 6 actors.\n"+
		"  op coverage (successful calls only):\n%s"+
		"  checkpoints with a non-empty FOURTH bucket: %d\n"+
		"  checkpoints where the THREE-term sum was SHORT: %d\n"+
		"  worst three-term shortfall: %s base units (seed %d)\n"+
		"  VERDICT: four-term identity HOLDS exactly at every checkpoint;\n"+
		"           three-term sum is short by exactly Σ PENDING escrow commission — H-10's bucket is REAL.",
		seeds, steps, seeds*steps, cov.String(), pendObserved, shortfallObserved, maxShortfall, shortfallSeed)
}

// ---------------------------------------------------------------------------
// TEST 2 — H-10, the deterministic minimal witness, printed.
// ---------------------------------------------------------------------------

func TestZP1_H10_MinimalWitness_PendingEscrowIsUncounted(t *testing.T) {
	s := NewMemStore()
	setStr(s, kOwner(), zp1Owner)
	const c = "zp1wc"
	const asker = "zp1wa"

	in, out := big.NewInt(0), big.NewInt(0)

	if err := Register(s, c, c, 100, 9090, 1_000_000); err != nil {
		t.Fatalf("Register: %v", err)
	}
	r, err := Buy(s, asker, c, 101, big.NewInt(1_000))
	if err != nil {
		t.Fatalf("Buy: %v", err)
	}
	in.Add(in, r.TotalDue)

	askBlock := zp1SeedObs(s, c, 200)
	setU64(s, kPaidUntil(c), askBlock+SubscriptionPeriod)

	lo, hi, err := ServiceFaceRange(s, c, askBlock)
	if err != nil {
		t.Fatalf("ServiceFaceRange: %v", err)
	}
	face := lo
	setMoney(s, kFace(c), face)
	t.Logf("legal posted-face window at supply=%s: [%s, %s]; using %s",
		getMoney(s, kSupply(c)), lo, hi, face)
	q, err := SettleSpend(s, c, askBlock, face)
	if err != nil {
		t.Fatalf("SettleSpend: %v", err)
	}
	before := zp1Sweep(t, s)
	ar, err := Ask(s, asker, c, askBlock, new(big.Int).Mul(q.Credits, big.NewInt(4)), q.CommissionHbd, "cid", MinAskDeadline, 0)
	if err != nil {
		t.Fatalf("Ask: %v", err)
	}
	in.Add(in, q.CommissionHbd)

	after := zp1Sweep(t, s)
	netIn := new(big.Int).Sub(in, out)

	t.Logf("BEFORE Ask: three=%s four=%s  net-in=%s", before.Three(), before.Four(), new(big.Int).Sub(new(big.Int).Sub(in, q.CommissionHbd), out))
	t.Logf("AFTER  Ask: reserve=%s treasury=%s feePots=%s escrowPending=%s",
		after.Reserve, after.Treasury, after.FeePots, after.EscrowPend)
	t.Logf("AFTER  Ask: three-term=%s  four-term=%s  actual net HBD in=%s", after.Three(), after.Four(), netIn)

	if after.EscrowPend.Cmp(q.CommissionHbd) != 0 {
		t.Fatalf("held commission = %s, want the paid %s", after.EscrowPend, q.CommissionHbd)
	}
	if after.Four().Cmp(netIn) != 0 {
		t.Fatalf("four-term sum %s != net HBD in %s", after.Four(), netIn)
	}
	shortfall := new(big.Int).Sub(netIn, after.Three())
	if shortfall.Cmp(q.CommissionHbd) != 0 {
		t.Fatalf("three-term shortfall = %s, want exactly the held commission %s", shortfall, q.CommissionHbd)
	}
	t.Logf("H-10 WITNESS: a three-term accounting pass (reserve+treasury+feePots) UNDER-COUNTS the "+
		"contract's real HBD by exactly %s base units — the commission held inside PENDING escrow e|%s|%d.",
		shortfall, c, ar.Seq)

	// ---- AND THE SWEEPER'S TRAP: field 5 survives resolution ----
	// A live sweep that sums field 5 without filtering on status would
	// DOUBLE-count a resolved escrow's commission.
	if _, err := Answer(s, c, c, askBlock+1, ar.Seq, "ans"); err != nil {
		t.Fatalf("Answer: %v", err)
	}
	post := zp1Sweep(t, s)
	if post.EscrowPend.Sign() != 0 {
		t.Fatalf("after Answer, pending bucket = %s, want 0", post.EscrowPend)
	}
	if post.EscrowAll.Cmp(q.CommissionHbd) != 0 {
		t.Fatalf("after Answer, field-5-over-ALL-records = %s, want the original %s", post.EscrowAll, q.CommissionHbd)
	}
	t.Logf("SWEEPER TRAP CONFIRMED: after Answer the commission is in the TREASURY (%s) and field 5 of the "+
		"now-ANSWERED record STILL reads %s. A live H-10 sweep that sums field 5 without filtering "+
		"status==PENDING over-counts by exactly that amount. Reclaim/Decline leave the same residue.",
		post.Treasury, post.EscrowAll)
	if post.Four().Cmp(new(big.Int).Sub(in, out)) != 0 {
		t.Fatalf("four-term %s != net in %s after Answer", post.Four(), new(big.Int).Sub(in, out))
	}
}
