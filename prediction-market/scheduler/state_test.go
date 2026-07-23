package scheduler

import (
	"testing"

	"hive-price-market/market"
)

func TestIsRoundOpen_NoRoundEver(t *testing.T) {
	st := MockStateReader{}
	open, id, err := IsRoundOpen(st, "vsc1x", "hive")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if open {
		t.Fatalf("expected not open, got open (id=%d)", id)
	}
}

func TestIsRoundOpen_ActiveZeroMeansNone(t *testing.T) {
	st := MockStateReader{"active|hive": "0"}
	open, _, err := IsRoundOpen(st, "vsc1x", "hive")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if open {
		t.Fatal("active|hive=0 should mean no round, not open")
	}
}

func TestIsRoundOpen_TrueWhenLatestRoundOpen(t *testing.T) {
	st := MockStateReader{
		"active|hive": "3", // round id 2 (stored as id+1)
		"rd|2|state":  market.StateOpen,
	}
	open, id, err := IsRoundOpen(st, "vsc1x", "hive")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !open || id != 2 {
		t.Fatalf("open=%v id=%d, want open=true id=2", open, id)
	}
}

func TestIsRoundOpen_FalseWhenLatestRoundSettled(t *testing.T) {
	st := MockStateReader{
		"active|hive": "3",
		"rd|2|state":  market.StateSettled,
	}
	open, id, err := IsRoundOpen(st, "vsc1x", "hive")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if open {
		t.Fatalf("expected not open (settled), got open (id=%d)", id)
	}
}

func TestIsRoundOpen_FalseWhenLatestRoundVoid(t *testing.T) {
	st := MockStateReader{
		"active|hive": "1", // round id 0
		"rd|0|state":  market.StateVoid,
	}
	open, _, err := IsRoundOpen(st, "vsc1x", "hive")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if open {
		t.Fatal("expected not open (void)")
	}
}

// TestIsRoundOpen_AssetIsolation proves the guard is per-asset: an open HBD
// round must never block a HIVE roll cycle (mirrors create.go's own
// kActiveRound(asset) keying).
func TestIsRoundOpen_AssetIsolation(t *testing.T) {
	st := MockStateReader{
		"active|hbd": "1",
		"rd|0|state": market.StateOpen,
	}
	open, _, err := IsRoundOpen(st, "vsc1x", "hive")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if open {
		t.Fatal("an open HBD round must not block a HIVE roll cycle")
	}
}

func TestReadRoundSchedule_NotFound(t *testing.T) {
	st := MockStateReader{}
	_, found, err := ReadRoundSchedule(st, "vsc1x", 7)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if found {
		t.Fatal("expected not found for a round that was never created")
	}
}

func TestReadRoundSchedule_ReadsFreshEveryCall(t *testing.T) {
	st := MockStateReader{
		"rd|2|state":  market.StateOpen,
		"rd|2|asset":  "hbd",
		"rd|2|settle": "5000",
		"rd|2|grace":  "300",
	}
	sched, found, err := ReadRoundSchedule(st, "vsc1x", 2)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !found {
		t.Fatal("expected found")
	}
	want := RoundSchedule{ID: 2, Asset: "hbd", State: market.StateOpen, SettleBlock: 5000, GraceBlocks: 300}
	if sched != want {
		t.Fatalf("ReadRoundSchedule = %+v, want %+v", sched, want)
	}

	// Statelessness: mutate the underlying map (simulating on-chain state
	// advancing between polls) and prove a second call re-reads fresh rather
	// than returning a cached value.
	st["rd|2|state"] = market.StateSettled
	sched2, found2, err := ReadRoundSchedule(st, "vsc1x", 2)
	if err != nil || !found2 {
		t.Fatalf("second read: found=%v err=%v", found2, err)
	}
	if sched2.State != market.StateSettled {
		t.Fatalf("second read State = %q, want settled (stale/cached read)", sched2.State)
	}
}

func TestReadRoundSchedule_MalformedSettleErrors(t *testing.T) {
	st := MockStateReader{
		"rd|2|state":  market.StateOpen,
		"rd|2|settle": "not-a-number",
		"rd|2|grace":  "300",
	}
	if _, _, err := ReadRoundSchedule(st, "vsc1x", 2); err == nil {
		t.Fatal("expected an error on a malformed settle block")
	}
}

func TestReadActiveRoundSchedule_NoRoundEver(t *testing.T) {
	st := MockStateReader{}
	_, found, err := ReadActiveRoundSchedule(st, "vsc1x", "hbd")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if found {
		t.Fatal("expected not found")
	}
}

func TestReadActiveRoundSchedule_FindsLatestRegardlessOfState(t *testing.T) {
	st := MockStateReader{
		"active|hbd":  "4", // round id 3 (stored as id+1)
		"rd|3|state":  market.StateVoid,
		"rd|3|asset":  "hbd",
		"rd|3|settle": "9000",
		"rd|3|grace":  "100",
	}
	sched, found, err := ReadActiveRoundSchedule(st, "vsc1x", "hbd")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !found || sched.ID != 3 || sched.State != market.StateVoid {
		t.Fatalf("ReadActiveRoundSchedule = %+v (found=%v), want id=3 state=void", sched, found)
	}
}
