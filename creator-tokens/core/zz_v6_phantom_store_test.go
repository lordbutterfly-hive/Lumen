package core

import "testing"

// phantomStore answers a MISSING key the way the VSC host does through
// sdk.StateGetObject: an empty string with ok == true. A MemStore answers
// ("", false), which is why the go tests and the real-wasm harness (no legacy
// state) both passed while the devnet update rehearsal (2026-09-22) read a
// legacy "2" as two units: the wrapper took the phantom ok as "already
// migrated" and never scaled or flagged anything.
type phantomStore struct{ m map[string]string }

func (p *phantomStore) Get(key string) (string, bool) { return p.m[key], true }
func (p *phantomStore) Set(key, value string)         { p.m[key] = value }
func (p *phantomStore) Delete(key string)             { delete(p.m, key) }

func TestV6Migrate_PhantomOkOnMissingFlagStillMigrates(t *testing.T) {
	raw := &phantomStore{m: map[string]string{}}
	raw.Set(kOwner(), "hive:platform")
	raw.Set(kRegisteredAt(v6c), "100")
	raw.Set(kState(v6c), "ACTIVE")
	raw.Set(kFace(v6c), "1000")
	raw.Set(kSupply(v6c), "3")
	raw.Set(kCap(v6c), "1000000")
	raw.Set(kReserve(v6c), "3047")
	raw.Set(kBal(v6c, v6h), "2")
	raw.Set(kAcqBlock(v6c, v6h), "1400")
	raw.Set(kBal(v6c, v6o), "1")
	raw.Set(kAcqBlock(v6c, v6o), "1500")
	raw.Set(kEscrow(v6c, 0), "hive:other|1|30000|PENDING|0|1300|1|ask-x|")
	raw.Set(kSeq(v6c), "1")
	s := WrapUnits(raw)
	if got := BalanceOf(s, v6c, v6h); got.Cmp(tk(2)) != 0 {
		t.Fatalf("legacy balance read as %s, want 200 units (the devnet defect)", got)
	}
	if got := Supply(s, v6c); got.Cmp(tk(3)) != 0 {
		t.Fatalf("legacy supply read as %s, want 300 units", got)
	}
	if v, _ := raw.Get(kUnitsHolder(v6c, v6h)); v != "1" {
		t.Fatalf("holder flag not written (%q)", v)
	}
	if v, _ := raw.Get(kUnitsMarket(v6c)); v != "1" {
		t.Fatalf("market flag not written (%q)", v)
	}
	// Idempotent through the phantom store too.
	if got := BalanceOf(s, v6c, v6h); got.Cmp(tk(2)) != 0 {
		t.Fatalf("second read = %s", got)
	}
	// And a buy on top lands in units: 2.00 + 1.00 = 300, never 2 + 100.
	if _, err := Buy(s, v6h, v6c, 2000, tk(1)); err != nil {
		t.Fatalf("buy: %v", err)
	}
	if got := BalanceOf(s, v6c, v6h); got.Cmp(tk(3)) != 0 {
		t.Fatalf("after buy = %s, want 300 units", got)
	}
	rec, ok := unpackEscrow(getStr(s, kEscrow(v6c, 0)))
	if !ok || rec.credits.Cmp(tk(1)) != 0 {
		t.Fatalf("legacy escrow through the phantom store = %+v ok=%v", rec, ok)
	}
}
