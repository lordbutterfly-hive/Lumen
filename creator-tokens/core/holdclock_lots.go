package core

import (
	"math/big"
	"strconv"
	"strings"
)

// holdclock_lots.go — the per-(creator,holder) MATURING COHORT LEDGER, the
// CANDIDATE storage change that closes PRICE-1 (the transfer/blend launder)
// without breaking the F-C1 bounded-grief contract.
//
// ---------------------------------------------------------------------------
// WHY A LEDGER IS NECESSARY (the impossibility the design brief asked us to
// settle). The exit tax needs, per sale, the FRESHNESS DISTRIBUTION of the
// maturing balance — not just its size and its blended average age. The single
// blended clock kAcqBlock is a LOSSY projection: two positions
//
//	(A) 4400 tokens all held 0.909 windows      -> blended age 0.909·Dt, rate 182
//	(B) 4000 tokens matured + 400 fresh         -> blended age 0.909·Dt, rate 182
//
// map to the SAME (balance, blended clock) yet owe DIFFERENT correct tax: (A)
// is homogeneous and owes 182 bps on its whole gross; (B)'s 400 fresh tokens
// owe the FULL 2000 bps on the dear top slice and its matured pile owes 0. No
// function of (balance, blended clock) can return the right answer for both, so
// no no-storage rule closes PRICE-1 without also over-charging honest holders
// of shape (A). The ledger below is the missing state: it records the cohorts
// so (A) and (B) are finally distinguishable.
//
// ADDITIVE AND BACKWARD-COMPATIBLE. kBal and kAcqBlock are UNCHANGED — every
// existing read (the blended rate the grief tests pin, P4's mpRate, the quote
// UI) is byte-for-byte identical. This ledger runs in PARALLEL and is consulted
// ONLY to compute a NON-DILUTABLE FLOOR on the maturing tax (maturingCohortTax
// below), taken as max(blendTax, cohortTax) at the sale. The floor can only
// ever RAISE the tax above the blend, and only for genuinely heterogeneous
// maturing buckets (aged + fresh) — exactly the launder shape. A homogeneous
// bucket has one cohort, so cohortTax == blendTax and the floor is a no-op.
//
// OURS, NOT MAGI-MARKET'S. magi-market reads the MATURED bucket ("bal|...")
// raw; the maturing family ("mb|", "acq|") is ours alone (keys.go), and this
// "lots|" family joins it — never read across the ABI, so its layout is free.
//
// MIGRATION. A pre-fix position has a maturing balance and a clock but no
// ledger. getLots SYNTHESISES a single cohort from (kBal, effective clock) for
// such a position, so it taxes EXACTLY as the blend does until real cohorts
// accrue through post-fix inflows — no migration transaction, no flag day.
//
// ---------------------------------------------------------------------------
// SCOPE (stated honestly, owner-facing):
//   - THE COHORT COUNT IS BOUNDED (2026-09-08). MaxLots below is a HARD cap
//     enforced at the only growth site (lotsCreditInflow -> boundLots): a holder
//     — or an attacker gifting a victim — can NEVER grow this ledger past
//     MaxLots cohorts, whatever the inflow count. See boundLots for the merge
//     rule and why it can neither dilute a fresh cohort's rate (no launder) nor
//     re-age an aged pile (no grief amplification). The earlier note here said
//     "production must BOUND the cohort count"; this is that bound.
//   - Encoding is still decimal/delimited for debuggability; production may
//     switch to the little-endian codec the matured family uses (matured.go).
//     DELIBERATELY NOT CHANGED HERE: the count bound is the security fix, the
//     codec is a size/consistency nicety, and re-encoding a live money ledger in
//     the same change would put the two at the same risk. Size is now bounded
//     either way (MaxLots cohorts).
//   - Wired on the CURVE Sell path (sell.go), the PRICE-1 headline. The
//     wind-down Refund rail pays a FLAT pro-rata price where marginal == average,
//     so the cohort floor equals the blend there (nothing to recover); X3's
//     wind-down variant is discussed in the report, not closed here.
// ---------------------------------------------------------------------------

// kLots is the maturing cohort ledger key. OURS (never read by magi-market).
func kLots(c, h string) string { return "lots|" + c + "|" + h }

// mLot is one acquisition cohort of the maturing bucket: `count` tokens whose
// own acquisition clock is `acq` (a block height, capped like every other clock
// at tax time, never here).
type mLot struct {
	count *big.Int
	acq   uint64
}

// getLots returns (c,h)'s maturing cohorts FRESHEST FIRST (highest acq first),
// the order a sale consumes them (maturing-at-the-top). READ-ONLY: it never
// writes, and in particular the migration synthesis below is in-memory only, so
// it is safe on the QuoteSell preview path.
//
// MIGRATION SYNTHESIS: a maturing balance with no ledger (a pre-fix position, or
// any path not yet routed through the hooks) is returned as a SINGLE cohort
// (kBal, effective clock). Its rate then equals the blend's exactly, so the
// cohort floor is a no-op until genuine cohorts accrue.
func getLots(s Store, c, h string) []mLot {
	raw := getStr(s, kLots(c, h))
	bal := getMoney(s, kBal(c, h))
	if raw == "" {
		if bal.Sign() == 0 {
			return nil
		}
		// Synthesise the legacy cohort. Use the SAME effective clock the blend
		// would use for this balance: unset => block-fresh is applied lazily by
		// the reader (lotRateAt), so store the raw stored clock here.
		return []mLot{{count: new(big.Int).Set(bal), acq: holderAcqBlock(s, c, h)}}
	}
	var lots []mLot
	for _, part := range strings.Split(raw, ";") {
		if part == "" {
			continue
		}
		fields := strings.SplitN(part, ",", 2)
		if len(fields) != 2 {
			continue
		}
		cnt, ok := new(big.Int).SetString(fields[0], 10)
		if !ok || cnt.Sign() <= 0 {
			continue
		}
		acq, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			continue
		}
		lots = append(lots, mLot{count: cnt, acq: acq})
	}
	sortLotsFreshestFirst(lots)
	return lots
}

// sortLotsFreshestFirst orders cohorts by DESCENDING acq (freshest at index 0).
// Insertion sort — the cohort count is small and bounded (see the scope note).
func sortLotsFreshestFirst(lots []mLot) {
	for i := 1; i < len(lots); i++ {
		for j := i; j > 0 && lots[j].acq > lots[j-1].acq; j-- {
			lots[j], lots[j-1] = lots[j-1], lots[j]
		}
	}
}

// setLots persists the ledger, deleting the key when empty (the matured family's
// delete-at-zero convention).
func setLots(s Store, c, h string, lots []mLot) {
	var b strings.Builder
	first := true
	for _, l := range lots {
		if l.count == nil || l.count.Sign() <= 0 {
			continue
		}
		if !first {
			b.WriteByte(';')
		}
		first = false
		b.WriteString(l.count.String())
		b.WriteByte(',')
		b.WriteString(strconv.FormatUint(l.acq, 10))
	}
	if first { // nothing written
		s.Delete(kLots(c, h))
		return
	}
	s.Set(kLots(c, h), b.String())
}

// ---------------------------------------------------------------------------
// THE COUNT BOUND (2026-09-08) — what stops a holder's ledger growing forever.
//
// THE HOLE IT CLOSES. lotsCreditInflow used to APPEND a new cohort for every
// distinct acq and merge only same-acq inflows. Cohort count was therefore
// UNBOUNDED in the number of distinct-block inflows, and inflows are not
// self-inflicted: TransferCredits lets ANY account push an inflow onto ANY
// holder. An attacker could grow a victim's `lots|` value without limit with
// dust gifts at distinct blocks — per-holder state bloat, ever-growing
// serialize/parse cost on the victim's own Sell/Refund (they pay the RC), i.e.
// a griefing / RC-exhaustion vector aimed at someone else's position.
//
// MaxLots is the hard cap. It is enforced at the ONLY growth site, so the
// invariant is STRUCTURAL, not statistical: after every write,
// len(lots) <= MaxLots.
//
// WHY 64. The maturity window is ExitTaxDecayBlocks = 42 days. 64 cohorts is
// above the header's own "one band per day => <= 42 within-window cohorts + 1
// aged" sizing, with 21 slots of headroom, so an HONEST holder — even one
// buying on 40-odd separate days inside a single window — is never merged at
// all. It also keeps the serialized value small and hard-bounded: <= 64 cohorts
// x <= ~32 bytes ("<count>,<acq>;") = ~2 KB per (creator,holder), versus
// unbounded before.
const MaxLots = 64

// collapseMaturedLots merges every cohort that is ALREADY MATURED at `block`
// (lotRateAt == 0) into ONE cohort carrying the YOUNGEST of their acqs.
//
// THIS MERGE IS EXACTLY TAX-NEUTRAL, NOW AND FOREVER — not "favourable", not
// "bounded": ZERO change to any tax, on either rail. Proof: lotRateAt(acq,
// block) == 0 requires 0 < acq <= block - ExitTaxDecayBlocks. The merged acq is
// the MAX of those, so it too satisfies acq <= block - ExitTaxDecayBlocks; and
// for any later read block' >= block, block' - acq >= block - acq >= the window,
// so the merged cohort reads rate 0 at every future block, exactly as each
// constituent would have. Rate 0 pays ExitTaxOn(x, 0) == 0 on the curve rail and
// the refund rail alike, with no ceil residue (0 * anything == 0).
//
// It is also ORDER-PRESERVING. Freshest-first order is descending acq, and the
// matured set is exactly the acqs in (0, block-Dt] — a CONTIGUOUS run in that
// order (cohorts above the floor sort before it; the degenerate acq == 0 cohort
// reads MaxExitTaxBps by holdclock.go's unset convention, is therefore not
// matured, and sorts after it). So the collapsed run occupies exactly the curve
// slices its constituents did.
//
// This is the FREE half of the bound: a long-lived holder's oldest cohorts are
// reclaimed at no cost before any lossy merge is even considered.
func collapseMaturedLots(lots []mLot, block uint64) []mLot {
	matured := 0
	for _, l := range lots {
		if lotRateAt(l.acq, block) == 0 {
			matured++
		}
	}
	if matured < 2 {
		return lots
	}
	sum := mZero()
	var maxAcq uint64
	out := make([]mLot, 0, len(lots)-matured+1)
	for _, l := range lots {
		if lotRateAt(l.acq, block) == 0 {
			sum = mAdd(sum, l.count)
			if l.acq > maxAcq {
				maxAcq = l.acq
			}
			continue
		}
		out = append(out, l)
	}
	out = append(out, mLot{count: sum, acq: maxAcq})
	sortLotsFreshestFirst(out)
	return out
}

// lotMergeCost is the COST METRIC the lossy merge minimises, in TOKEN-BLOCKS OF
// MATURITY CONFISCATED: pulling the OLDER cohort's acq up to the YOUNGER one's
// takes (yAcq - older.acq) blocks of accrued maturity away from each of
// older.count tokens. It is the time-invariant statement of the harm — unlike a
// "bps difference right now", which reads 0 for two cohorts whose rates happen
// to coincide today but diverge tomorrow.
func lotMergeCost(older mLot, yAcq uint64) *big.Int {
	return new(big.Int).Mul(older.count, new(big.Int).SetUint64(yAcq-older.acq))
}

// mergeCheapestAdjacentLot merges the ADJACENT pair (freshest-first order) whose
// lotMergeCost is smallest, at the YOUNGER of the two acqs, and returns a slice
// one shorter. `lots` must be sorted freshest-first and hold >= 2 cohorts.
//
// THE YOUNGER acq, ALWAYS — this is the no-under-tax rule and the no-launder
// rule at once. lotRateAt is NON-DECREASING in acq (a higher acq is younger, so
// fewer held blocks, so a rate at least as high) at EVERY block, so the merged
// cohort's rate is >= BOTH constituents' rates forever. Adjacent cohorts occupy
// adjacent curve slices, so the merged cohort covers exactly their union and
// maturingCohortTax charges rate(younger) x (sliceYoung + sliceOld) >=
// rate(younger) x sliceYoung + rate(older) x sliceOld: the merge can only ever
// RAISE the tax. A fresh cohort can therefore never be pulled DOWN onto an aged
// cohort's rate, which is the whole of the PRICE-1 / X3 launder.
//
// WHY THE CHEAPEST ADJACENT PAIR AND NOT SIMPLY "THE TWO OLDEST". The two-oldest
// rule is safe under its own stated premise — "both are the lowest-rate, closest
// to matured" — and collapseMaturedLots above implements exactly that case, for
// free, first. But the premise is NOT an invariant an attacker has to respect.
// Take a victim holding ONE large aged cohort and let an attacker gift dust at
// MaxLots distinct blocks: the ledger is then [dust, dust, ..., dust, AGED], and
// "the two oldest" are the victim's AGED PILE and one fresh dust cohort. Merging
// those at the younger acq is treasury-favouring, but it RE-AGES THE VICTIM'S
// ENTIRE PILE TO FRESH — a rate jump from 0 to MaxExitTaxBps on their whole
// position, bought for MaxLots+1 dust transfers. That trades a state-bloat grief
// for a far worse tax grief, so it is not shipped.
//
// Minimising lotMergeCost removes the leverage. To steer the merge onto a
// victim's big cohort an attacker must make EVERY other adjacent pair cost more
// than count_victim x delta_victim; with dust cohorts costing ~1 x delta the
// arithmetic forces delta_victim below ~1 block, i.e. the victim can lose at
// most a couple of token-blocks of maturity — under 0.01 bps on any position.
// The attacker's own dust is always the cheapest thing to merge, so the attacker
// pays for cohorts that merge into each other.
//
// DETERMINISM (consensus): a single fixed-order scan, big.Int comparison, ties
// broken toward the LATER (older) pair — no maps, no iteration order, no
// floating point.
func mergeCheapestAdjacentLot(lots []mLot) []mLot {
	best := 0
	bestCost := lotMergeCost(lots[1], lots[0].acq)
	for i := 1; i+1 < len(lots); i++ {
		cost := lotMergeCost(lots[i+1], lots[i].acq)
		if cost.Cmp(bestCost) <= 0 { // <= : ties fall to the OLDER pair
			best, bestCost = i, cost
		}
	}
	merged := mLot{
		count: mAdd(lots[best].count, lots[best+1].count),
		acq:   lots[best].acq, // the YOUNGER acq — never under-taxes
	}
	out := make([]mLot, 0, len(lots)-1)
	out = append(out, lots[:best]...)
	out = append(out, merged)
	out = append(out, lots[best+2:]...)
	return out
}

// boundLots enforces len(lots) <= MaxLots: first the FREE, exactly tax-neutral
// collapse of the matured tail, then — only if still over — the cheapest
// adjacent merges, each at the younger acq. Σ counts is invariant under both
// (every merge is count-additive), so the Σlots == kBal ledger invariant is
// untouched. Input must be sorted freshest-first; output is too.
func boundLots(lots []mLot, block uint64) []mLot {
	if len(lots) <= MaxLots {
		return lots
	}
	lots = collapseMaturedLots(lots, block)
	for len(lots) > MaxLots {
		lots = mergeCheapestAdjacentLot(lots)
	}
	return lots
}

// lotsCreditInflow records an inflow of n tokens carrying clock `acqSlice` onto
// (c,h). Called from creditInflowAt AFTER the (unchanged) balance/clock write,
// with the PRE-credit balance `oldBal` and its effective clock `wSynth` so a
// legacy (un-ledgered) position is synthesised into its first cohort before the
// new one is appended. Cohorts sharing an acq are merged, which bounds same-block
// churn.
//
// ★ BOUNDED (2026-09-08). This is the ONLY site at which the cohort count can
// grow, so it is the only site that has to enforce the cap: the appended cohort
// is re-sorted into freshest-first order and boundLots then merges the ledger
// back down to <= MaxLots. `block` is the caller's current block — needed only
// to tell which cohorts are already matured (the free, tax-neutral collapse).
// boundLots is a no-op below the cap, so the honest path is byte-identical to
// before. It is called on the same-acq path too, so a ledger that somehow
// arrived over the cap (state written by pre-bound code) is repaired by its next
// inflow rather than staying over forever.
func lotsCreditInflow(s Store, c, h string, oldBal *big.Int, wSynth uint64, n *big.Int, acqSlice, block uint64) {
	if n == nil || n.Sign() <= 0 {
		return
	}
	lots := getLotsRaw(s, c, h)
	if len(lots) == 0 && oldBal != nil && oldBal.Sign() > 0 {
		lots = []mLot{{count: new(big.Int).Set(oldBal), acq: wSynth}}
	}
	merged := false
	for i := range lots {
		if lots[i].acq == acqSlice {
			lots[i].count = mAdd(lots[i].count, n)
			merged = true
			break
		}
	}
	if !merged {
		lots = append(lots, mLot{count: new(big.Int).Set(n), acq: acqSlice})
		sortLotsFreshestFirst(lots) // the appended cohort may be the freshest
	}
	lots = boundLots(lots, block)
	setLots(s, c, h, lots)
}

// getLotsRaw is getLots WITHOUT the migration synthesis — used by the writers,
// which handle synthesis explicitly against the PRE-write balance.
func getLotsRaw(s Store, c, h string) []mLot {
	raw := getStr(s, kLots(c, h))
	if raw == "" {
		return nil
	}
	var lots []mLot
	for _, part := range strings.Split(raw, ";") {
		if part == "" {
			continue
		}
		fields := strings.SplitN(part, ",", 2)
		if len(fields) != 2 {
			continue
		}
		cnt, ok := new(big.Int).SetString(fields[0], 10)
		if !ok || cnt.Sign() <= 0 {
			continue
		}
		acq, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			continue
		}
		lots = append(lots, mLot{count: cnt, acq: acq})
	}
	sortLotsFreshestFirst(lots)
	return lots
}

// lotsDebit removes n tokens from the ledger, FRESHEST FIRST (the tokens leaving
// a maturing sale are the dear top slice). Called from debitBalance AFTER the
// (unchanged) balance write, with `preBal` the pre-debit maturing balance and
// `wSynth` its effective clock for legacy synthesis.
func lotsDebit(s Store, c, h string, preBal *big.Int, wSynth uint64, n *big.Int) {
	if n == nil || n.Sign() <= 0 {
		return
	}
	lots := getLotsRaw(s, c, h)
	if len(lots) == 0 {
		if preBal == nil || preBal.Sign() == 0 {
			return
		}
		// ★ NEVER PERSIST AN UNCLOCKED COHORT (2026-09-08, scrutiny finding 4).
		// debitBalance passes the RAW stored clock, and an unset one (0) means
		// "this balance never went through the hold clock". Writing it into the
		// ledger would freeze the position at acq 0, which lotRateAt reads as
		// MaxExitTaxBps AT EVERY BLOCK FOREVER — a permanent maximum tax with no
		// maturity path, unlike the blended clock, which self-heals on the next
		// inflow (holdclock.go's zero-value convention normalises wOld to
		// `block`). Leaving the ledger ABSENT keeps the same (treasury-favouring)
		// rate today via getLots' synthesis, and lets the position heal the
		// moment a clocked inflow arrives. No core path produces kBal > 0 with an
		// unset clock — but this contract is an UPDATE over live v1 state whose
		// writers are not in this tree, so the defensive branch is not dead code.
		if wSynth == 0 {
			return
		}
		lots = []mLot{{count: new(big.Int).Set(preBal), acq: wSynth}}
	}
	remaining := new(big.Int).Set(n)
	out := lots[:0]
	for _, l := range lots {
		if remaining.Sign() == 0 {
			out = append(out, l)
			continue
		}
		if l.count.Cmp(remaining) <= 0 {
			remaining = new(big.Int).Sub(remaining, l.count)
			continue // whole cohort consumed
		}
		l.count = new(big.Int).Sub(l.count, remaining)
		remaining = mZero()
		out = append(out, l)
	}
	setLots(s, c, h, out)
}

// lotsClear drops the whole ledger — called from graduate(), which empties the
// maturing bucket into matured. When maturedNow fires, the blended age has
// reached the cap, which (every cohort being capped at the window) means EVERY
// cohort is at the cap and owes 0, so clearing them is exactly right.
func lotsClear(s Store, c, h string) {
	s.Delete(kLots(c, h))
}

// lotRateAt is the exit-tax rate for a cohort acquired at block `acq`, read as
// of `block` — the per-cohort analogue of ExitTaxBpsAt(heldBlocksAt(...)).
// Unset/ahead-of-block => maximally fresh (max rate), the treasury-favouring
// convention holdclock.go uses; past the window => 0.
func lotRateAt(acq, block uint64) uint64 {
	if acq == 0 || acq >= block {
		return MaxExitTaxBps
	}
	held := block - acq
	if held > ExitTaxDecayBlocks {
		held = ExitTaxDecayBlocks
	}
	return ExitTaxBpsAt(held)
}

// maturingCohortTax is the NON-DILUTABLE exit tax on the top `fromMaturing`
// maturing tokens of a curve sale from `supply`: each cohort is taxed at ITS OWN
// rate on ITS OWN marginal curve slice, freshest cohort on the dearest top
// slice. A matured/aged cohort (rate 0) can never pull a fresh cohort's rate
// down, because the two are taxed on DISJOINT slices — which is exactly what the
// single blended clock could not express.
//
// Returns the tax, the total taxable slice (== SellProceeds(supply,
// fromMaturing), by telescoping), and the EFFECTIVE rate that tax was actually
// struck at.
//
// ★★★ THE THIRD RETURN WAS THE FRESHEST COHORT'S RATE AND THAT WAS NOT AN
// HONEST HEADLINE (TAXBPS-DISPLAY, 2026-09-08). It is now the SLICE-WEIGHTED
// effective rate
//
//	effBps = ceil( Σ sliceᵢ·rateᵢ / Σ sliceᵢ )
//
// which is the ONLY single number that describes a heterogeneous charge. The
// two candidates it replaces both mis-report, in OPPOSITE directions, and both
// were measured on this tree:
//
//   - THE BLENDED CLOCK (what SellResult.TaxBps carried until now):
//     ExitTaxBpsAt(heldBlocksAt(...)) is a size-weighted summary of the whole
//     maturing bucket, so an aged pile drags it toward 0 while the sale draws
//     the FRESH cohort sitting on the top slice. Measured: reported 2 bps
//     against a charge of 395,326,266,413 base units on a taxable gross of
//     2,635,508,442,750 — the FULL 1500 bps. A 750x understatement of the rate
//     beside an exactly-correct amount.
//   - THE FRESHEST COHORT'S RATE (this function's previous third return): right
//     whenever the draw is consumed entirely from one cohort, and wrong the
//     moment it is not. Measured on the same position selling 2,000 instead of
//     1,000 tokens: freshest-cohort 1500 bps against a true 751.25 bps — a 2x
//     OVER-statement. On the dust-gift shape (one gifted token on a 100,000
//     matured pile) it reads 1500 bps against a true 1.51 bps, a ~1000x
//     over-statement.
//
// The weighted form is EXACT — not approximately, exactly — for every
// homogeneous position at EVERY size: one cohort makes it ceil(slice·τ/slice)
// == τ, with no ceil residue to leak in (which is precisely why it is not
// ceil(tax·1e4/taxable): ExitTaxOn's own per-cohort ceil pushes that ratio 1 bps
// ABOVE the schedule on an ordinary single-rate sale — 1501 where the schedule
// says 1500 — so the naive effective ratio would have regressed the common path
// to fix the rare one).
//
// CEIL is RULING F's direction (round against the payer). It cannot exceed
// MaxExitTaxBps and so needs no clamp: every rateᵢ <= MaxExitTaxBps, so the
// weighted mean is <= MaxExitTaxBps, and ceil of a value <= an integer is that
// integer.
//
// ZERO/NON-ZERO IS PRESERVED against the old freshest-cohort return, which is
// what the boundary tests assert: all-cohorts-at-0 gives Σ sliceᵢ·rateᵢ == 0 and
// so effBps == 0, and any cohort with a nonzero rate on a nonzero slice makes
// the sum positive and effBps >= 1.
func maturingCohortTax(s Store, c, h string, supply, fromMaturing *big.Int, block uint64) (tax, taxable *big.Int, effBps uint64, err error) {
	tax = mZero()
	taxable = mZero()
	weighted := mZero() // Σ sliceᵢ·rateᵢ — the numerator of the effective rate
	if fromMaturing == nil || fromMaturing.Sign() == 0 {
		return tax, taxable, 0, nil
	}
	lots := getLots(s, c, h) // freshest first, with legacy synthesis
	remaining := new(big.Int).Set(fromMaturing)
	curTop := new(big.Int).Set(supply)
	for _, l := range lots {
		if remaining.Sign() == 0 {
			break
		}
		take := l.count
		if take.Cmp(remaining) > 0 {
			take = remaining
		}
		slice, e := SellProceeds(curTop, take) // Area(curTop) − Area(curTop−take)
		if e != nil {
			return nil, nil, 0, e // unreachable: take <= remaining <= fromMaturing <= supply
		}
		rate := lotRateAt(l.acq, block)
		tax = mAdd(tax, ExitTaxOn(slice, rate))
		taxable = mAdd(taxable, slice)
		weighted = mAdd(weighted, new(big.Int).Mul(slice, new(big.Int).SetUint64(rate)))
		curTop = new(big.Int).Sub(curTop, take)
		remaining = new(big.Int).Sub(remaining, take)
	}
	// remaining should be 0 here (Σ cohort counts == kBal >= fromMaturing). If a
	// ledger somehow under-counts, tax the shortfall at the MAX rate on the next
	// slice — treasury-favouring, never an under-charge.
	if remaining.Sign() > 0 {
		slice, e := SellProceeds(curTop, remaining)
		if e != nil {
			return nil, nil, 0, e
		}
		tax = mAdd(tax, ExitTaxOn(slice, MaxExitTaxBps))
		taxable = mAdd(taxable, slice)
		weighted = mAdd(weighted, new(big.Int).Mul(slice, new(big.Int).SetUint64(MaxExitTaxBps)))
	}
	if taxable.Sign() > 0 {
		// ceil(Σ sliceᵢ·rateᵢ / Σ sliceᵢ), <= MaxExitTaxBps by construction.
		effBps = mMulDivCeil(weighted, big.NewInt(1), taxable).Uint64()
	}
	return tax, taxable, effBps, nil
}

// ---------------------------------------------------------------------------
// COHORT-FAITHFUL MOVEMENT (2026-09-08) — the transfer-hop launder closes here.
//
// THE HOLE IT CLOSES. Everything above made the ledger authoritative at TAX
// time and left it un-consulted at MOVE time: TransferCredits read the sender's
// single blended clock (transfer.go) and creditInflowAt stamped that ONE value
// as the recipient's new cohort. So one permissionless hop collapsed a
// heterogeneous ledger — the exact (aged pile + fresh slice) shape this file
// exists to keep distinguishable — back into ONE homogeneous cohort at the
// DILUTED blended rate, and the sale-side floor could not see it, because at the
// recipient the blend and the cohort now agree. Measured on the untouched tree:
// 90.87% of the exit tax avoided at a 4,000-token pile, 99.93% at 4,000,000, in
// a SINGLE block, repeatable daily against the same never-consumed pile.
//
// THE RULE. A slice of tokens carries its COHORTS, not a summary of them. The
// draw is FRESHEST FIRST — the same order lotsDebit already removes them in, so
// what the sender loses and what the recipient gains are the same tokens, and
// the sender's aged remainder is left intact rather than being averaged away.
//
// WHY THIS CANNOT MANUFACTURE MATURITY. Every cohort moves at ITS OWN acq, so
// Σ count·min(age, window) over both accounts is unchanged by the move (and is
// then only ever REDUCED by capAcqAge and by boundLots' merge-at-the-younger-acq
// rule). A sender still cannot give away age they do not have, cannot give away
// more than one window of it, and cannot keep what they gave.
//
// WHY THIS CANNOT WORSEN THE F-C1 GRIEF (the ruling this leg re-opens). The
// worst gift a recipient can be given is a MAXIMALLY FRESH one, and that is
// already reachable today at zero cost: an attacker buys in the front-run block
// and their blended clock IS `block`, so the gift already lands at
// MaxExitTaxBps. Cohort-faithful movement changes the outcome ONLY when the
// SENDER is heterogeneous, and then only by sending the freshest cohorts rather
// than a blend of all of them — i.e. it moves the result TOWARD the already
// reachable worst case and can never move it past it. The grief ceiling is
// therefore unchanged; what changes is that an ATTACKER can no longer use a
// heterogeneous sender to launder a fresh slice into an aged one.
// ---------------------------------------------------------------------------

// lotsDrawFreshest returns the cohorts that a MATURING debit of `n` tokens
// consumes, freshest first — exactly the cohorts lotsDebit removes, read BEFORE
// the debit. Pure read (getLots, so a legacy un-ledgered position synthesises
// its single cohort and behaves byte-identically to the blend).
//
// A ledger that under-counts (Σ counts < n, unreachable under Σ lots == kBal)
// contributes the shortfall as acq 0, which creditInflowAt normalises to `block`
// — MAXIMALLY FRESH, the treasury-favouring direction, never a free ride.
func lotsDrawFreshest(s Store, c, h string, n *big.Int) []mLot {
	if n == nil || n.Sign() <= 0 {
		return nil
	}
	lots := getLots(s, c, h) // freshest first, with legacy synthesis
	remaining := new(big.Int).Set(n)
	out := make([]mLot, 0, len(lots)+1)
	for _, l := range lots {
		if remaining.Sign() == 0 {
			break
		}
		take := l.count
		if take.Cmp(remaining) > 0 {
			take = remaining
		}
		out = append(out, mLot{count: new(big.Int).Set(take), acq: l.acq})
		remaining = new(big.Int).Sub(remaining, take)
	}
	if remaining.Sign() > 0 {
		out = append(out, mLot{count: remaining, acq: 0})
	}
	return out
}

// lotsBlendAcq is the size-weighted mean acquisition block of a cohort list,
// each input normalised and capped exactly as creditInflowAt normalises its two
// average inputs, and the result rounded UP (ceil == YOUNGER == more tax) and
// capped again at the write. It is the blended clock that the SAME tokens would
// carry if they had all arrived through the average — used to re-derive
// kAcqBlock when graduate() removes only PART of the maturing bucket and the
// stored blend would otherwise describe a composition that no longer exists.
//
// Returns 0 for an empty list; callers must not store that (0 is the unset
// sentinel), and graduate() does not: an empty green list is the full-graduation
// path, which deletes the clock outright.
func lotsBlendAcq(lots []mLot, block uint64) uint64 {
	num := mZero()
	den := mZero()
	for _, l := range lots {
		if l.count == nil || l.count.Sign() <= 0 {
			continue
		}
		a := l.acq
		if a == 0 || a > block {
			a = block // the zero-value convention: unclocked == maximally fresh
		}
		a = capAcqAge(a, block)
		num = mAdd(num, new(big.Int).Mul(l.count, hcU64(a)))
		den = mAdd(den, l.count)
	}
	if den.Sign() == 0 {
		return 0
	}
	return capAcqAge(mMulDivCeil(num, big.NewInt(1), den).Uint64(), block)
}

// splitLotsByRate partitions a cohort list into the RIPE cohorts (lotRateAt == 0
// at `block` — they owe nothing, now and at every future block, by the
// monotonicity argument in collapseMaturedLots) and the GREEN cohorts that still
// owe tax. Order within each part is preserved, so both come back freshest-first
// if the input was. `ripeSum` is Σ ripe counts.
func splitLotsByRate(lots []mLot, block uint64) (ripe, green []mLot, ripeSum *big.Int) {
	ripeSum = mZero()
	for _, l := range lots {
		if l.count == nil || l.count.Sign() <= 0 {
			continue
		}
		if lotRateAt(l.acq, block) == 0 {
			ripe = append(ripe, l)
			ripeSum = mAdd(ripeSum, l.count)
			continue
		}
		green = append(green, l)
	}
	return ripe, green, ripeSum
}

// holderHasGreenCohort reports whether ANY cohort of (c,h)'s MATURING bucket
// still owes exit tax at `block` — the per-cohort form of "this holder is still
// taxed", used by RefundHolder's consent gate (refund.go) where the blended
// clock alone reads 0 for a heterogeneous bucket whose fresh cohorts are still
// young. Pure read, and it honours the legacy synthesis: an un-ledgered position
// yields exactly one cohort at the stored clock, so this agrees with
// ExitTaxBpsAt(heldBlocksAt(...)) != 0 for every homogeneous/legacy holder and
// can only ever ADD "still owes" for a genuinely heterogeneous one.
func holderHasGreenCohort(s Store, c, h string, block uint64) bool {
	_, green, _ := splitLotsByRate(getLots(s, c, h), block)
	return len(green) > 0
}

// ---------------------------------------------------------------------------
// ESCROW COHORT CARRY (2026-09-08) — the third door the blend leaked through.
//
// Ask() draws its credits through debitPosition, so the MATURING part of the
// draw is taken freshest-first out of the cohort ledger; but the escrow record
// stored only ONE blended clock for it, and every return leg (Reclaim, Decline)
// and the delivery leg (Answer) credited the whole slice back at that single
// value. An escrow round trip therefore re-stamped a fresh slice with the
// holder's blended rate — the same launder transfer.go had, on a door that is
// permissionless (Reclaim, after the deadline) or same-block (Decline, by the
// creator, who may be the attacker's own market).
//
// These two helpers record and replay the drawn cohorts. Absent record =>
// pre-fix escrow => the caller falls back to rec.acqBlock, unchanged.
// ---------------------------------------------------------------------------

// saveEscrowLots records the cohorts an escrow's MATURING leg was drawn from.
// Writing nothing when the leg is empty keeps a wholly-matured ask free of extra
// state, exactly as kEscrowMaturedLeg does.
func saveEscrowLots(s Store, c string, seq uint64, lots []mLot) {
	var b strings.Builder
	first := true
	for _, l := range lots {
		if l.count == nil || l.count.Sign() <= 0 {
			continue
		}
		if !first {
			b.WriteByte(';')
		}
		first = false
		b.WriteString(l.count.String())
		b.WriteByte(',')
		b.WriteString(strconv.FormatUint(l.acq, 10))
	}
	if first {
		s.Delete(kEscrowLots(c, seq))
		return
	}
	s.Set(kEscrowLots(c, seq), b.String())
}

// loadEscrowLots reads the recorded cohorts back, freshest first, CLAMPED to
// `credits` so a record that somehow disagrees with the escrow it belongs to can
// never credit more tokens than the escrow holds. Returns nil when there is no
// record (a pre-fix escrow) — the caller then uses the packed acqBlock.
func loadEscrowLots(s Store, c string, seq uint64, credits *big.Int) []mLot {
	raw := getStr(s, kEscrowLots(c, seq))
	if raw == "" || credits == nil || credits.Sign() <= 0 {
		return nil
	}
	var lots []mLot
	for _, part := range strings.Split(raw, ";") {
		if part == "" {
			continue
		}
		fields := strings.SplitN(part, ",", 2)
		if len(fields) != 2 {
			continue
		}
		cnt, ok := new(big.Int).SetString(fields[0], 10)
		if !ok || cnt.Sign() <= 0 {
			continue
		}
		acq, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			continue
		}
		lots = append(lots, mLot{count: cnt, acq: acq})
	}
	if len(lots) == 0 {
		return nil
	}
	sortLotsFreshestFirst(lots)
	// Clamp to `credits`, FRESHEST FIRST — a truncated record therefore drops the
	// OLDEST (cheapest) cohorts, never the freshest, so the clamp can only ever
	// raise the tax the returned tokens owe.
	out := make([]mLot, 0, len(lots))
	remaining := new(big.Int).Set(credits)
	for _, l := range lots {
		if remaining.Sign() == 0 {
			break
		}
		take := l.count
		if take.Cmp(remaining) > 0 {
			take = remaining
		}
		out = append(out, mLot{count: new(big.Int).Set(take), acq: l.acq})
		remaining = new(big.Int).Sub(remaining, take)
	}
	if remaining.Sign() > 0 {
		return nil // the record under-covers the escrow: distrust it entirely
	}
	return out
}

// consumeEscrowLots clears the cohort record once the escrow has settled — the
// same second-lock reasoning consumeEscrowMaturedLeg documents.
func consumeEscrowLots(s Store, c string, seq uint64) {
	s.Delete(kEscrowLots(c, seq))
}
