package core

// Err is a typed contract error. The pure core returns these; the wasm layer
// maps them to sdk.Revert(msg, symbol) so callers and wallets can branch on the
// symbol. Mirrors hive-price-market/market/errors.go.
type Err struct {
	Symbol string
	Msg    string
}

func (e *Err) Error() string { return e.Symbol + ": " + e.Msg }

func newErr(symbol, msg string) *Err { return &Err{Symbol: symbol, Msg: msg} }

// Error symbols.
const (
	ErrAuth     = "AUTH"
	ErrInput    = "INPUT"
	ErrState    = "STATE"
	ErrArith    = "ARITH"
	ErrBalance  = "BALANCE"
	ErrPaused   = "PAUSED"
	ErrNotFound = "NOT_FOUND"
	ErrOracle   = "ORACLE"
	ErrCap      = "CAP"
	// ErrDelinquent is returned ONLY by RequireInflowOpen's delivery-standing
	// branch (market.go). It exists because ErrState is shared by dozens of
	// unrelated refusals, so nothing downstream could tell "refused because
	// the creator is delinquent" apart from "answer window closed" without
	// matching the message TEXT. The simulator's standing-guardrail check did
	// exactly that, which meant a reword of one sentence would have silently
	// turned its halt into a no-op that still printed as a pass. Branch on
	// this symbol, never on wording.
	ErrDelinquent = "DELINQUENT"
)
