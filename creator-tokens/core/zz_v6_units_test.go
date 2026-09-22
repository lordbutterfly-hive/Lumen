package core

import (
	"math/big"
	"testing"
)

// v6 unit plumbing: the wire carries tokens as decimals, state carries units.
func TestV6_ParseTokens(t *testing.T) {
	good := map[string]int64{
		"1": 100, "01": 100, "+1": 100, "2": 200, "1.5": 150, "1.50": 150, "0.01": 1, "0.1": 10,
		"0": 0, "0.00": 0, "1000000000": 100_000_000_000, "123456.78": 12_345_678,
	}
	for in, want := range good {
		v, err := parseTokens(in)
		if err != nil {
			t.Fatalf("parseTokens(%q) refused: %v", in, err)
		}
		if v.Cmp(big.NewInt(want)) != 0 {
			t.Fatalf("parseTokens(%q) = %s, want %d", in, v, want)
		}
	}
	for _, bad := range []string{"", ".", "1.", ".5", "0.001", "1.005", "1e3", "-1", "--1", "+-1", " 1", "1 ", "1,5", "0x10", "abc", "1.2.3", "+", "1.-1"} {
		if v, err := parseTokens(bad); err == nil {
			t.Fatalf("parseTokens(%q) accepted %s, want refusal", bad, v)
		}
	}
}

func TestV6_FmtTokens(t *testing.T) {
	cases := map[int64]string{0: "0.00", 1: "0.01", 10: "0.10", 100: "1.00", 150: "1.50", 12_345_678: "123456.78", 100_000_000_000: "1000000000.00"}
	for units, want := range cases {
		if got := fmtTokens(big.NewInt(units)); got != want {
			t.Fatalf("fmtTokens(%d) = %q, want %q", units, got, want)
		}
	}
	if got := fmtTokens(nil); got != "0.00" {
		t.Fatalf("fmtTokens(nil) = %q", got)
	}
	// Round trip: every wire string the formatter emits parses back to the same units.
	for _, units := range []int64{0, 1, 7, 99, 100, 101, 12_345_678} {
		back, err := parseTokens(fmtTokens(big.NewInt(units)))
		if err != nil || back.Cmp(big.NewInt(units)) != 0 {
			t.Fatalf("round trip %d: %v %v", units, back, err)
		}
	}
	if TokenScale != 100 || TokenDecimals != 2 || MissReclaimFloorUnits != TokenScale || MinTradeUnits != 1 || MinFeeBaseUnits != 1 {
		t.Fatal("v6 unit constants changed; re-derive every expectation in the zz_v6 files")
	}
}
