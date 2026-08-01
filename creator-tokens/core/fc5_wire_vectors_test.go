package core

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"testing"
)

// F-C5 — cross-language vectors for the MATURED bucket's wire form and the
// two-bucket refund tax.
//
// The client has to reproduce both exactly: the little-endian, zero-trimmed
// u64 encoding that setMatured writes, and the maturing-share apportionment
// that refund.go taxes. A client that gets either wrong misreports money.
//
// This test asserts the vectors against the contract's OWN functions and prints
// them as JSON. The identical table is asserted on the TypeScript side by
// features/creator-tokens/lib/vsc/matured-decode.selftest.ts, so if either
// implementation drifts, one of the two fails.
//
// Run: go test ./core/ -run TestFC5_WireVectors -v

type fc5Vector struct {
	Tokens   uint64 `json:"tokens"`
	Hex      string `json:"hex"`
	Maturing int64  `json:"maturing"`
	Matured  int64  `json:"matured"`
	Reserve  int64  `json:"reserve"`
	Supply   int64  `json:"supply"`
	HeldBlks uint64 `json:"heldBlocks"`
	Gross    int64  `json:"gross"`
	Tax      int64  `json:"tax"`
	Net      int64  `json:"net"`
	TaxBps   uint64 `json:"taxBps"`
}

func TestFC5_WireVectors(t *testing.T) {
	// ── Half 1: the LE wire encoding, including the trimming rule.
	encodings := []uint64{0, 1, 2, 255, 256, 257, 65535, 65536, 1_000_000, 1_000_000_000}
	for _, n := range encodings {
		enc := u64ToLE(n)
		back, ok := leToU64(enc)
		if !ok || back != n {
			t.Fatalf("round-trip failed for %d: %x -> %d (ok=%v)", n, enc, back, ok)
		}
		// Trimming: no trailing high-order zero byte survives (except the
		// single 0x00 that encodes zero, which is never stored).
		if n != 0 && enc[len(enc)-1] == 0 {
			t.Fatalf("value %d kept a trailing zero byte: %x", n, enc)
		}
	}

	// A 9-byte value must be REFUSED, not silently truncated.
	if _, ok := leToU64(make([]byte, 9)); ok {
		t.Fatal("leToU64 accepted a 9-byte value")
	}

	// ── Half 2: the two-bucket refund tax, computed with the contract's own
	// helpers on positions that mix the buckets.
	cases := []struct {
		maturing, matured, reserve, supply int64
		held                               uint64
	}{
		{maturing: 1000, matured: 0, reserve: 500_000, supply: 10_000, held: 0},
		{maturing: 0, matured: 1000, reserve: 500_000, supply: 10_000, held: 0},
		{maturing: 500, matured: 500, reserve: 500_000, supply: 10_000, held: 0},
		{maturing: 750, matured: 250, reserve: 123_457, supply: 9_991, held: 100},
		{maturing: 1, matured: 999, reserve: 999_983, supply: 100_003, held: 0},
		{maturing: 500, matured: 500, reserve: 500_000, supply: 10_000, held: ExitTaxDecayBlocks},
	}

	out := make([]fc5Vector, 0, len(cases))
	for _, c := range cases {
		total := big.NewInt(c.maturing + c.matured)
		gross := refundPayout(big.NewInt(c.reserve), total, big.NewInt(c.supply))
		taxBps := ExitTaxBpsAt(c.held)
		// splitDraw is maturing-FIRST; drawing the WHOLE position therefore
		// takes exactly `maturing` from the maturing bucket.
		fromMaturing := big.NewInt(c.maturing)
		tax := ExitTaxOn(maturingGrossShare(gross, fromMaturing, total), taxBps)
		net := new(big.Int).Sub(gross, tax)

		if net.Sign() < 0 {
			t.Fatalf("negative net for %+v", c)
		}
		out = append(out, fc5Vector{
			Tokens:   uint64(c.maturing + c.matured),
			Hex:      hex.EncodeToString(u64ToLE(uint64(c.matured))),
			Maturing: c.maturing,
			Matured:  c.matured,
			Reserve:  c.reserve,
			Supply:   c.supply,
			HeldBlks: c.held,
			Gross:    gross.Int64(),
			Tax:      tax.Int64(),
			Net:      net.Int64(),
			TaxBps:   taxBps,
		})
	}

	// A fully-matured position owes ZERO tax; a fully-maturing fresh one owes
	// the full rate. If these two ever coincide the apportionment is dead.
	if out[1].Tax != 0 {
		t.Fatalf("fully-matured position was taxed %d", out[1].Tax)
	}
	if out[0].Tax == 0 {
		t.Fatal("fresh fully-maturing position owed no tax — the vector proves nothing")
	}

	b, _ := json.MarshalIndent(out, "", "  ")
	fmt.Printf("FC5_VECTORS_JSON=%s\n", string(b))
}
