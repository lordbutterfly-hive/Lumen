package core

import (
	"math/big"
	"strings"
	"testing"
)

// wtok is an allowance / door amount in WHOLE tokens (the marketplace unit).
func wtok(n int64) *big.Int { return big.NewInt(n) }

// ★ THE WHOLE-TOKEN DOOR (v6, 2026-09-22; scrutiny HIGH-1 / MEDIUM-2 / MEDIUM-3).
//
// magi-market and every NFT-standard reader decode `bal|` and `allow|` as
// integers with no decimals hint, so those keys keep meaning WHOLE tokens after
// the update, byte for byte. The fraction below one token lives in a NEW key,
// `balf|`, that no reader outside Lumen looks at, and the door refuses to move
// it. These tests pin the codec, the refusal, the allowance unit, and that a
// pre-v6 `bal|` reads correctly with NO migration write at all.

func TestV6Door_MaturedSplitsWholeAndRemainder(t *testing.T) {
	s := NewMemStore()
	const c, h = "hive:alice", "hive:bob"

	setMatured(s, c, h, big.NewInt(150)) // 1.50
	if v, ok := s.Get(kMatured(h, c)); !ok || v != string(u64ToLE(1)) {
		t.Fatalf("bal| = %x, want LE(1): the door key must hold WHOLE tokens", v)
	}
	if v, ok := s.Get(kMaturedFrac(h, c)); !ok || v != "50" {
		t.Fatalf("balf| = %q, want \"50\"", v)
	}
	if got := getMatured(s, c, h); got.Cmp(big.NewInt(150)) != 0 {
		t.Fatalf("getMatured = %s, want 150 units", got)
	}
	if got := maturedWholeOf(s, c, h); got.Cmp(wtok(1)) != 0 {
		t.Fatalf("maturedWholeOf = %s, want 1", got)
	}

	setMatured(s, c, h, big.NewInt(300)) // exactly 3.00: no remainder key
	if _, ok := s.Get(kMaturedFrac(h, c)); ok {
		t.Fatal("balf| left behind for a whole-token balance")
	}
	if got := getMatured(s, c, h); got.Cmp(big.NewInt(300)) != 0 {
		t.Fatalf("getMatured = %s, want 300", got)
	}

	setMatured(s, c, h, big.NewInt(7)) // 0.07: below one token, no bal| at all
	if _, ok := s.Get(kMatured(h, c)); ok {
		t.Fatal("bal| present for a sub-token balance; magi-market would read a phantom 0")
	}
	if got := getMatured(s, c, h); got.Cmp(big.NewInt(7)) != 0 {
		t.Fatalf("getMatured = %s, want 7", got)
	}
	if got := maturedWholeOf(s, c, h); got.Sign() != 0 {
		t.Fatalf("maturedWholeOf = %s, want 0", got)
	}

	setMatured(s, c, h, mZero())
	if _, ok := s.Get(kMatured(h, c)); ok {
		t.Fatal("bal| not deleted at zero")
	}
	if _, ok := s.Get(kMaturedFrac(h, c)); ok {
		t.Fatal("balf| not deleted at zero")
	}
}

func TestV6Door_LegacyMaturedReadsWithoutAnyWrite(t *testing.T) {
	raw := NewMemStore()
	const c, h = "hive:alice", "hive:bob"
	raw.Set(kMatured(h, c), string(u64ToLE(3))) // a v5.1 market wrote "3 tokens"
	before := len(raw.Keys())
	s := WrapUnits(raw)
	if got := getMatured(s, c, h); got.Cmp(big.NewInt(300)) != 0 {
		t.Fatalf("legacy bal|=3 reads as %s units, want 300", got)
	}
	if got := maturedWholeOf(s, c, h); got.Cmp(wtok(3)) != 0 {
		t.Fatalf("whole = %s, want 3 (what magi-market has always read)", got)
	}
	if len(raw.Keys()) != before {
		t.Fatalf("a matured READ wrote %d key(s); bal| needs no migration", len(raw.Keys())-before)
	}
	if v, _ := raw.Get(kMatured(h, c)); v != string(u64ToLE(3)) {
		t.Fatalf("bal| rewritten to %x; it must stay byte-identical", v)
	}
}

func TestV6Door_MovesWholeTokensOnlyAndAllowanceIsWhole(t *testing.T) {
	s, c, h := drSetup(t) // h holds 1000.00 matured
	const mkt, carol = "hive:market", "hive:carol"

	// Owner-spender: a fraction never crosses the door, whatever the balance.
	for _, units := range []int64{1, 50, 99, 101, 150, 100_000 + 1} {
		if err := TransferMatured(s, c, h, carol, h, big.NewInt(units)); err == nil {
			t.Fatalf("door moved %d units (not a whole-token multiple)", units)
		} else if !strings.Contains(err.Error(), "whole tokens") {
			t.Fatalf("wrong refusal for %d units: %v", units, err)
		}
	}
	if err := TransferMatured(s, c, h, carol, h, tk(2)); err != nil {
		t.Fatalf("2 whole tokens refused: %v", err)
	}
	if got := getMatured(s, c, carol); got.Cmp(tk(2)) != 0 {
		t.Fatalf("carol matured = %s, want 200 units", got)
	}

	// Third party: the allowance is WHOLE tokens and decrements by the whole count.
	if err := Approve(s, h, mkt, c, mZero(), wtok(3)); err != nil {
		t.Fatalf("approve: %v", err)
	}
	if err := TransferMatured(s, c, h, carol, mkt, tk(2)); err != nil {
		t.Fatalf("spend 2 of 3: %v", err)
	}
	if got := AllowanceOf(s, h, mkt, c); got.Cmp(wtok(1)) != 0 {
		t.Fatalf("allowance = %s after 2 of 3, want 1 whole token", got)
	}
	if err := TransferMatured(s, c, h, carol, mkt, tk(2)); err == nil {
		t.Fatal("spent 2 with 1 left")
	}
	if err := TransferMatured(s, c, h, carol, mkt, tk(1)); err != nil {
		t.Fatalf("spend the last whole token: %v", err)
	}
	if got := AllowanceOf(s, h, mkt, c); got.Sign() != 0 {
		t.Fatalf("allowance = %s, want 0", got)
	}
	// The stored allowance is the same LE u64 of whole tokens magi-market reads.
	if err := Approve(s, h, mkt, c, mZero(), wtok(7)); err != nil {
		t.Fatalf("approve: %v", err)
	}
	if v, _ := s.Get(kAllowance(h, mkt, c)); v != string(u64ToLE(7)) {
		t.Fatalf("allow| = %x, want LE(7)", v)
	}
	// Ceiling in whole tokens: the cap's whole-token count, not the unit count.
	if err := Approve(s, h, mkt, c, wtok(7), big.NewInt(MaxCap/TokenScale+1)); err == nil {
		t.Fatal("allowance above the whole-token cap accepted")
	}
	if err := Approve(s, h, mkt, c, wtok(7), big.NewInt(MaxCap/TokenScale)); err != nil {
		t.Fatalf("allowance at the whole-token cap refused: %v", err)
	}
}

// A sub-token fraction is fully SPENDABLE inside Lumen even though the door
// cannot move it: sell and refund draw units, not whole tokens.
func TestV6Door_FractionSpendableThroughLumenRails(t *testing.T) {
	s, c, h := drSetup(t)
	const carol = "hive:carol"
	if err := TransferMatured(s, c, h, carol, h, tk(1)); err != nil {
		t.Fatal(err)
	}
	// carol sells 0.30 of her 1.00 matured token: the remainder 0.70 lives in balf|.
	at := uint64(2_000_000)
	if _, err := Sell(s, carol, c, at, big.NewInt(30)); err != nil {
		t.Fatalf("sell 0.30 matured: %v", err)
	}
	if got := getMatured(s, c, carol); got.Cmp(big.NewInt(70)) != 0 {
		t.Fatalf("carol matured = %s, want 70 units", got)
	}
	if _, ok := s.Get(kMatured(carol, c)); ok {
		t.Fatal("bal| present at 0.70: magi-market would see a phantom whole token")
	}
	if err := TransferMatured(s, c, carol, h, carol, tk(1)); err == nil {
		t.Fatal("moved a whole token out of a 0.70 position")
	}
	if _, err := Sell(s, carol, c, at+1, big.NewInt(70)); err != nil {
		t.Fatalf("sell the remaining 0.70: %v", err)
	}
	if got := getMatured(s, c, carol); got.Sign() != 0 {
		t.Fatalf("carol matured = %s after selling out, want 0", got)
	}
	if _, ok := s.Get(kMaturedFrac(carol, c)); ok {
		t.Fatal("balf| left behind at zero")
	}
}

// ★ INFO-15 / INFO-16 (scrutiny 2026-09-22): the migration flag is written only
// when EVERY present value converted, and a cohort record that does not parse
// fails the conversion instead of being silently dropped.
func TestV6Migrate_FlagOnlyAfterEveryValueConverted(t *testing.T) {
	raw := NewMemStore()
	const c, h = "hive:alice", "hive:bob"
	raw.Set(kBal(c, h), "7")
	raw.Set(kLots(c, h), "5,1000;garbage")
	s := WrapUnits(raw)
	getMoney(s, kBal(c, h)) // touches the holder
	if v, _ := raw.Get(kUnitsHolder(c, h)); v == "1" {
		t.Fatal("holder flagged although the cohort ledger failed to convert")
	}
	if v, _ := raw.Get(kLots(c, h)); v != "5,1000;garbage" {
		t.Fatalf("lots rewritten to %q on a failed conversion", v)
	}
	if v, _ := raw.Get(kBal(c, h)); v != "700" {
		t.Fatalf("mb| = %q, want 700 (the values that DID convert are kept)", v)
	}
	// A retry with a clean ledger completes and flags.
	raw.Set(kLots(c, h), "5,1000;2,2000")
	raw.Set(kBal(c, h), "7")
	getMoney(s, kBal(c, h))
	if v, _ := raw.Get(kUnitsHolder(c, h)); v != "1" {
		t.Fatal("holder not flagged after a clean conversion")
	}
	if v, _ := raw.Get(kLots(c, h)); v != "500,1000;200,2000" {
		t.Fatalf("lots = %q", v)
	}
}

func TestV6Migrate_ScaleLotsStringIsStrict(t *testing.T) {
	good := []struct{ in, want string }{
		{"5,1000", "500,1000"},
		{"5,1000;2,2000", "500,1000;200,2000"},
		{"5,1000;;2,2000", "500,1000;200,2000"},
		{"", ""},
	}
	for _, g := range good {
		if got, ok := scaleLotsString(g.in); !ok || got != g.want {
			t.Fatalf("scaleLotsString(%q) = %q,%v want %q,true", g.in, got, ok, g.want)
		}
	}
	for _, bad := range []string{"garbage", "5", "0,1000", "-1,1000", "x,1000", "5,1000;7"} {
		if _, ok := scaleLotsString(bad); ok {
			t.Fatalf("scaleLotsString(%q) accepted", bad)
		}
	}
}
