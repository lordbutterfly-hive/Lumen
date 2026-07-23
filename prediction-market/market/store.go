package market

// Store is the persistent key/value state the market logic operates on. In the
// wasm contract it is backed by the VSC SDK state (per-contract namespaced); in
// tests it is a plain in-memory map. Keeping the logic behind this interface is
// what lets every fund path be exercised under `go test` without TinyGo.
type Store interface {
	Get(key string) (string, bool)
	Set(key, value string)
	Delete(key string)
}
