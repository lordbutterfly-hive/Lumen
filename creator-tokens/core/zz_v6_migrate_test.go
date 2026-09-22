package core

import (
	"math/big"
	"strings"
	"testing"
)

// The lazy unit migration (migrate_v6.go), driven from pre-v6 fixtures written
// straight into a raw MemStore, then read through the wrapped store the way the
// wasm wrapper and every core function do.

const v6c, v6h, v6o = "hive:creator", "hive:holder", "hive:other"

func legacyMarket(t *testing.T) (*MemStore, Store) {
	t.Helper()
	raw := NewMemStore()
	setStr(raw, kOwner(), "hive:platform")
	raw.Set(kSupply(v6c), "12")
	raw.Set(kCap(v6c), "1000000000")
	raw.Set(kReserve(v6c), "12615")
	raw.Set(kBal(v6c, v6h), "7")
	raw.Set(kMatured(v6h, v6c), string(u64ToLE(3)))
	raw.Set(kLots(v6c, v6h), "5,1000;2,2000")
	raw.Set(kAcqBlock(v6c, v6h), "1400")
	raw.Set(kBal(v6c, v6o), "1")
	raw.Set(kAcqBlock(v6c, v6o), "1900")
	// escrow seq 0: 9 fields, 1 credit, commission 0, acq 1300, offering 1
	raw.Set(kEscrow(v6c, 0), "hive:other|1|30000|PENDING|0|1300|1|ask-14woy0|")
	raw.Set(kEscrowMaturedLeg(v6c, 0), "1")
	raw.Set(kEscrowLots(v6c, 0), "1,1300")
	raw.Set(kSeq(v6c), "1")
	return raw, WrapUnits(raw)
}

func TestV6Migrate_HolderKeysScaleTogetherOnce(t *testing.T) {
	raw, s := legacyMarket(t)
	if got := getMoney(s, kBal(v6c, v6h)); got.Cmp(big.NewInt(700)) != 0 {
		t.Fatalf("maturing balance = %s, want 700 units", got)
	}
	if got := getMatured(s, v6c, v6h); got.Cmp(big.NewInt(300)) != 0 {
		t.Fatalf("matured = %s, want 300 units", got)
	}
	lots := getLots(s, v6c, v6h)
	if len(lots) != 2 || lots[0].count.Cmp(big.NewInt(200)) != 0 || lots[0].acq != 2000 || lots[1].count.Cmp(big.NewInt(500)) != 0 || lots[1].acq != 1000 {
		t.Fatalf("lots = %+v, want counts x100 with the same acq blocks", lots)
	}
	if v, _ := raw.Get(kUnitsHolder(v6c, v6h)); v != "1" {
		t.Fatal("holder flag not set")
	}
	if v, _ := raw.Get(kAcqBlock(v6c, v6h)); v != "1400" {
		t.Fatalf("acq clock moved: %s", v)
	}
	// Idempotent: a second read changes nothing.
	before, _ := raw.Get(kBal(v6c, v6h))
	getMoney(s, kBal(v6c, v6h))
	after, _ := raw.Get(kBal(v6c, v6h))
	if before != after || before != "700" {
		t.Fatalf("second read rewrote the balance: %s -> %s", before, after)
	}
	// The other holder is untouched until touched.
	if v, _ := raw.Get(kBal(v6c, v6o)); v != "1" {
		t.Fatalf("untouched holder was migrated early: %s", v)
	}
}

func TestV6Migrate_MarketAndEscrowKeys(t *testing.T) {
	raw, s := legacyMarket(t)
	if got := Supply(s, v6c); got.Cmp(big.NewInt(1200)) != 0 {
		t.Fatalf("supply = %s, want 1200", got)
	}
	if got := Cap(s, v6c); got.Cmp(big.NewInt(100_000_000_000)) != 0 {
		t.Fatalf("cap = %s, want 1e11", got)
	}
	if got := Reserve(s, v6c); got.Cmp(big.NewInt(12615)) != 0 {
		t.Fatalf("reserve (HBD) must not scale: %s", got)
	}
	rec, ok := loadEscrow(s, v6c, 0)
	if !ok || rec.credits.Cmp(big.NewInt(100)) != 0 || rec.commissionCredits.Sign() != 0 || rec.acqBlock != 1300 || rec.offeringID != 1 || rec.contentHash != "ask-14woy0" || rec.asker != v6o {
		t.Fatalf("legacy escrow read wrong: %+v", rec)
	}
	stored, _ := raw.Get(kEscrow(v6c, 0))
	if len(strings.Split(stored, "|")) != escrowFieldsV6 || !strings.Contains(stored, "|"+escrowUnitsMarker+"|") {
		t.Fatalf("escrow not rewritten to 10 fields: %q", stored)
	}
	if v, _ := raw.Get(kEscrowMaturedLeg(v6c, 0)); v != "100" {
		t.Fatalf("escrow matured leg = %s, want 100", v)
	}
	if v, _ := raw.Get(kEscrowLots(v6c, 0)); v != "100,1300" {
		t.Fatalf("escrow lots = %s, want 100,1300", v)
	}
	// A 9-field record read WITHOUT the wrapper still reports units (parser fallback).
	rec2, ok := unpackEscrow("hive:other|3|30000|PENDING|0|1300|1|ask-x|")
	if !ok || rec2.credits.Cmp(big.NewInt(300)) != 0 {
		t.Fatalf("raw 9-field parse = %+v", rec2)
	}
	// A 10-field record without the marker is refused (a corrupt or foreign layout).
	if _, ok := unpackEscrow("hive:other|300|30000|PENDING|0|1300|1|zz|ask-x|"); ok {
		t.Fatal("accepted a 10-field record without the units marker")
	}
	// Pack then unpack is the identity in units.
	back, ok := unpackEscrow(packEscrow(rec))
	if !ok || back.credits.Cmp(rec.credits) != 0 || back.contentHash != rec.contentHash || back.answerHash != rec.answerHash {
		t.Fatalf("pack/unpack drift: %+v vs %+v", back, rec)
	}
}

// I3 in units across a half-migrated market: supply == maturing + matured + escrowed
// for every holder, whether or not that holder has been touched yet.
func TestV6Migrate_SupplyInvariantAcrossMixedState(t *testing.T) {
	_, s := legacyMarket(t)
	sum := mAdd(getMoney(s, kBal(v6c, v6h)), getMatured(s, v6c, v6h)) // touches holder 1 only
	rec, _ := loadEscrow(s, v6c, 0)
	sum = mAdd(sum, rec.credits)
	sum = mAdd(sum, mAdd(getMoney(s, kBal(v6c, v6o)), getMatured(s, v6c, v6o))) // now holder 2
	if sum.Cmp(Supply(s, v6c)) != 0 {
		t.Fatalf("I3 broken: balances+escrow %s != supply %s", sum, Supply(s, v6c))
	}
}

// A write into an unmigrated holder converts the holder first, so a fresh
// inflow never lands beside token-denominated siblings.
func TestV6Migrate_WriteConvertsFirst(t *testing.T) {
	raw, s := legacyMarket(t)
	setMoney(s, kBal(v6c, v6o), big.NewInt(150)) // units
	if v, _ := raw.Get(kUnitsHolder(v6c, v6o)); v != "1" {
		t.Fatal("write did not set the holder flag")
	}
	if got := getMoney(s, kBal(v6c, v6o)); got.Cmp(big.NewInt(150)) != 0 {
		t.Fatalf("written units re-scaled: %s", got)
	}
	// Wrapping twice is a no-op.
	if WrapUnits(s) != s {
		t.Fatal("double wrap")
	}
}

// A market registered AFTER v6 never sees the migration: its keys are written in
// units from the start and the flags are set on the first touch with nothing to scale.
func TestV6Migrate_FreshMarketUntouched(t *testing.T) {
	raw := NewMemStore()
	s := WrapUnits(raw)
	setStr(s, kOwner(), "hive:platform")
	if err := Register(s, v6c, v6c, 1000, 1000, MaxCap); err != nil {
		t.Fatalf("register: %v", err)
	}
	if _, err := Buy(s, v6h, v6c, 1000, big.NewInt(150)); err != nil {
		t.Fatalf("buy 1.50: %v", err)
	}
	if got := Supply(s, v6c); got.Cmp(big.NewInt(150)) != 0 {
		t.Fatalf("supply = %s, want 150", got)
	}
	if got := getMoney(s, kBal(v6c, v6h)); got.Cmp(big.NewInt(150)) != 0 {
		t.Fatalf("balance = %s, want 150", got)
	}
}
