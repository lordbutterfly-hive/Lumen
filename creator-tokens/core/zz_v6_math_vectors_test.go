package core

import (
	"encoding/json"
	"math/big"
	"math/rand"
	"os"
	"testing"
)

// Cross-language MATH VECTORS for the v6 frontend (features/creator-tokens/lib
// contract-math.ts, replayed by v6-math-vectors.selftest.ts). Every figure is
// produced by the contract's own functions on a seeded random sweep, so the
// TypeScript port is measured against the contract rather than against itself.
// Regenerate with:  V6_VECTORS=1 go test ./core/ -run TestV6_EmitMathVectors -count=1
// The file is committed (testdata/v6-math-vectors.json); the test below also
// re-derives every row so a drift in core fails here first.

type v6BuyVec struct {
	SupplyUnits int64 `json:"supplyUnits"`
	Units       int64 `json:"units"`
	Cost        int64 `json:"cost"`
	Fee         int64 `json:"fee"`
	Total       int64 `json:"total"`
	SpotAfter   int64 `json:"spotAfter"`
}
type v6Lot struct {
	Units int64  `json:"units"`
	Acq   uint64 `json:"acq"`
}
type v6SellVec struct {
	SupplyUnits int64   `json:"supplyUnits"`
	Units       int64   `json:"units"`
	Maturing    int64   `json:"maturingUnits"`
	Matured     int64   `json:"maturedUnits"`
	Lots        []v6Lot `json:"lots"`
	Block       uint64  `json:"block"`
	HeldBlocks  uint64  `json:"heldBlocks"`
	Gross       int64   `json:"gross"`
	Tax         int64   `json:"tax"`
	TaxBps      uint64  `json:"taxBps"`
	Fee         int64   `json:"fee"`
	Net         int64   `json:"net"`
}
type v6AskVec struct {
	Face       int64 `json:"face"`
	Rate       int64 `json:"rate"`
	Units      int64 `json:"units"`
	Commission int64 `json:"commissionUnits"`
}
type v6RefundVec struct {
	Reserve     int64 `json:"reserve"`
	Units       int64 `json:"units"`
	SupplyUnits int64 `json:"supplyUnits"`
	Gross       int64 `json:"gross"`
}
type v6MiscVec struct {
	Units  int64  `json:"units"`
	Area   int64  `json:"area"`
	Spot   int64  `json:"spot"`
	Format string `json:"format"`
}
type v6Vectors struct {
	Seed   int64         `json:"seed"`
	Buy    []v6BuyVec    `json:"buy"`
	Sell   []v6SellVec   `json:"sell"`
	Ask    []v6AskVec    `json:"ask"`
	Refund []v6RefundVec `json:"refund"`
	Misc   []v6MiscVec   `json:"misc"`
}

func v6BuildVectors(t *testing.T, seed int64, n int) v6Vectors {
	t.Helper()
	rng := rand.New(rand.NewSource(seed))
	out := v6Vectors{Seed: seed}
	for i := 0; i < n; i++ {
		u := rng.Int63n(5_000_000) // up to 50,000 tokens
		k := 1 + rng.Int63n(50_000)
		cost := BuyCost(big.NewInt(u), big.NewInt(k))
		fee, _, _ := tradeFeeOn(cost)
		out.Buy = append(out.Buy, v6BuyVec{SupplyUnits: u, Units: k, Cost: cost.Int64(), Fee: fee.Int64(), Total: cost.Int64() + fee.Int64(), SpotAfter: SpotRate(big.NewInt(u + k)).Int64()})
	}
	const c, h = "hive:vcreator", "hive:vholder"
	for i := 0; i < n; i++ {
		supply := 1 + rng.Int63n(5_000_000)
		held := 1 + rng.Int63n(supply)
		if held > 200_000 {
			held = 200_000
		}
		maturing := rng.Int63n(held + 1)
		matured := held - maturing
		k := 1 + rng.Int63n(held)
		block := uint64(3_000_000)
		// 1..3 cohorts, freshest first, counts summing to the maturing balance.
		var lots []v6Lot
		if maturing > 0 {
			nl := 1 + rng.Intn(3)
			rem := maturing
			for j := 0; j < nl; j++ {
				cnt := rem
				if j < nl-1 && rem > 1 {
					cnt = 1 + rng.Int63n(rem)
				}
				age := uint64(rng.Int63n(int64(ExitTaxDecayBlocks) + 100_000))
				lots = append(lots, v6Lot{Units: cnt, Acq: block - age})
				rem -= cnt
				if rem == 0 {
					break
				}
			}
		}
		s := NewMemStore()
		setStr(s, kOwner(), "hive:platform")
		setupMarket(s, c, 100, MaxCap/TokenScale)
		setMoney(s, kSupply(c), big.NewInt(supply))
		setMoney(s, kReserve(c), Area(big.NewInt(supply)))
		if maturing > 0 {
			setMoney(s, kBal(c, h), big.NewInt(maturing))
			ml := make([]mLot, 0, len(lots))
			var wsum, wcnt int64
			for _, l := range lots {
				ml = append(ml, mLot{count: big.NewInt(l.Units), acq: l.Acq})
				wsum += int64(l.Acq) * l.Units
				wcnt += l.Units
			}
			sortLotsFreshestFirst(ml)
			setLots(s, c, h, ml)
			setU64(s, kAcqBlock(c, h), uint64(wsum/wcnt))
		}
		if matured > 0 {
			setMatured(s, c, h, big.NewInt(matured))
		}
		q, err := QuoteSell(s, h, c, block, big.NewInt(k))
		if err != nil {
			t.Fatalf("vector %d: QuoteSell: %v", i, err)
		}
		heldBlocks := heldBlocksAt(s, c, h, block)
		sorted := make([]v6Lot, len(lots))
		copy(sorted, lots)
		for a := 0; a < len(sorted); a++ {
			for b := a + 1; b < len(sorted); b++ {
				if sorted[b].Acq > sorted[a].Acq {
					sorted[a], sorted[b] = sorted[b], sorted[a]
				}
			}
		}
		out.Sell = append(out.Sell, v6SellVec{SupplyUnits: supply, Units: k, Maturing: maturing, Matured: matured, Lots: sorted, Block: block, HeldBlocks: heldBlocks,
			Gross: q.Gross.Int64(), Tax: q.Tax.Int64(), TaxBps: q.TaxBps, Fee: q.Fee.Int64(), Net: q.Net.Int64()})
	}
	for i := 0; i < n; i++ {
		face := MinFace + rng.Int63n(MaxFace-MinFace)
		rate := 1000 + rng.Int63n(5_000_000)
		units := mMulDivCeil(big.NewInt(face), unitsScale, big.NewInt(rate))
		out.Ask = append(out.Ask, v6AskVec{Face: face, Rate: rate, Units: units.Int64(), Commission: mMulBpsDiv(units, CommissionBps).Int64()})
	}
	for i := 0; i < n; i++ {
		supply := 1 + rng.Int63n(5_000_000)
		units := 1 + rng.Int63n(supply)
		reserve := Area(big.NewInt(supply)).Int64() - rng.Int63n(1000)
		if reserve < 0 {
			reserve = 0
		}
		out.Refund = append(out.Refund, v6RefundVec{Reserve: reserve, Units: units, SupplyUnits: supply, Gross: refundPayout(big.NewInt(reserve), big.NewInt(units), big.NewInt(supply)).Int64()})
	}
	for i := 0; i < n; i++ {
		u := rng.Int63n(10_000_000)
		out.Misc = append(out.Misc, v6MiscVec{Units: u, Area: Area(big.NewInt(u)).Int64(), Spot: SpotRate(big.NewInt(u)).Int64(), Format: fmtTokens(big.NewInt(u))})
	}
	return out
}

func TestV6_EmitMathVectors(t *testing.T) {
	v := v6BuildVectors(t, 20260922, 300)
	b, _ := json.Marshal(v)
	if os.Getenv("V6_VECTORS") != "" {
		if err := os.WriteFile("testdata/v6-math-vectors.json", b, 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("wrote testdata/v6-math-vectors.json (%d bytes)", len(b))
		return
	}
	// Committed file must match what core computes today (drift alarm).
	have, err := os.ReadFile("testdata/v6-math-vectors.json")
	if err != nil {
		t.Skipf("no committed vectors yet: %v", err)
	}
	var want v6Vectors
	if err := json.Unmarshal(have, &want); err != nil {
		t.Fatal(err)
	}
	wb, _ := json.Marshal(want)
	if string(wb) != string(b) {
		t.Fatal("committed v6-math-vectors.json no longer matches core: regenerate with V6_VECTORS=1 and re-run the TS selftest")
	}
}
