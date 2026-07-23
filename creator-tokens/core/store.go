package core

// Store is the persistent key/value state the core logic operates on. In the
// wasm contract it is backed by the VSC SDK state (namespaced per-contract); in
// tests it is a plain in-memory map. Keeping the logic behind this interface is
// what lets every fund path be exercised under `go test` without TinyGo.
type Store interface {
	Get(key string) (string, bool)
	Set(key, value string)
	Delete(key string)
}

// CrossReader reads another contract's state (sdk.ContractStateGet). Only the
// price-oracle path needs it; kept as a separate, tiny interface so the whole
// core stays testable with a map.
type CrossReader interface {
	ContractStateGet(contractID, key string) (string, bool)
}

// MemStore is the in-memory Store used by tests.
type MemStore struct{ m map[string]string }

func NewMemStore() *MemStore { return &MemStore{m: map[string]string{}} }

func (s *MemStore) Get(key string) (string, bool) {
	v, ok := s.m[key]
	return v, ok
}

func (s *MemStore) Set(key, value string) { s.m[key] = value }

func (s *MemStore) Delete(key string) { delete(s.m, key) }

// Keys returns every key currently set. Test-only helper for invariant sweeps.
func (s *MemStore) Keys() []string {
	out := make([]string, 0, len(s.m))
	for k := range s.m {
		out = append(out, k)
	}
	return out
}
