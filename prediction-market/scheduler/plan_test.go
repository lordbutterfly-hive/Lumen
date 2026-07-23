package scheduler

import (
	"testing"

	"hive-price-market/market"
)

// memStore is a minimal market.Store implementation for tests — the exact
// same shape as market/market_test.go's own (unexported, so duplicated
// here); this package cannot reach into market's test-only helpers.
type memStore struct{ m map[string]string }

func newMemStore() *memStore                    { return &memStore{m: map[string]string{}} }
func (s *memStore) Get(k string) (string, bool) { v, ok := s.m[k]; return v, ok }
func (s *memStore) Set(k, v string)             { s.m[k] = v }
func (s *memStore) Delete(k string)             { delete(s.m, k) }

// TestDefaultConfig_AssetMatchesRollRound is the critical rewire check: the
// pre-re-skin scheduler defaulted Config.Asset to market.AssetHive, but
// market.RollRound (market/create.go:157-166) hardcodes `Asset: AssetHbd`
// for every round it opens ("stake token = HBD (stable payout unit)"). A
// stale Asset default would make the overlap guard and the settle keeper's
// round discovery watch "active|hive" — a state key `roll` never writes —
// and silently never find a round at all.
func TestDefaultConfig_AssetMatchesRollRound(t *testing.T) {
	cfg := DefaultConfig("vsc1test")
	if cfg.Asset != market.AssetHbd {
		t.Fatalf("DefaultConfig().Asset = %q, want market.AssetHbd (%q)", cfg.Asset, market.AssetHbd)
	}
}

func TestConfig_OpConfig(t *testing.T) {
	cfg := Config{NetID: "vsc-testnet", ContractID: "vsc1abc", RCLimit: 42, Asset: market.AssetHbd}
	oc := cfg.opConfig()
	if oc.NetID != "vsc-testnet" || oc.ContractID != "vsc1abc" || oc.RCLimit != 42 {
		t.Fatalf("opConfig() = %+v, want {vsc-testnet vsc1abc 42}", oc)
	}
}
