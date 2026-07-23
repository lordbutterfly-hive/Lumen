// Package sim is a population SIMULATOR for the hive-price-market `market`
// package — it drives the REAL, unmodified market.* functions (RollRound,
// RecordBet, Settle, VoidStale, Claim, Reclaim, SweepUnclaimed) against a real
// in-memory Store over a population of simulated actors across many weekly
// rounds, asserting fund-safety invariants after every action.
//
// This package owns nothing about the wasm layer or SDK — it only needs
// market.Store (an interface: Get/Set/Delete). Nothing in market/, contract/,
// indexer/, or scheduler/ is modified.
package sim

// MemStore is a plain in-memory market.Store — the same shape as the
// unexported memStore in market/market_test.go, re-implemented here (as an
// exported type) because the simulator lives in a different package and
// cannot import test-only types.
type MemStore struct {
	m map[string]string
}

// NewMemStore returns an empty, ready-to-use in-memory Store.
func NewMemStore() *MemStore {
	return &MemStore{m: map[string]string{}}
}

func (s *MemStore) Get(key string) (string, bool) {
	v, ok := s.m[key]
	return v, ok
}

func (s *MemStore) Set(key, value string) {
	s.m[key] = value
}

func (s *MemStore) Delete(key string) {
	delete(s.m, key)
}

// Len reports the number of live keys (debugging / trace-size sanity only).
func (s *MemStore) Len() int { return len(s.m) }
