package sim

import (
	"fmt"
	"math/big"

	"hive-price-market/market"
)

// InvariantViolation is returned (never silently swallowed) the instant any
// fund-safety assertion fails. It carries everything needed to reproduce:
// the seed, the week/block/round, the offending trace event, and a
// human-readable explanation. cmd/marketsim treats a non-nil *InvariantViolation
// from Simulator.Run as fatal and prints it loudly.
type InvariantViolation struct {
	Seed    int64
	Week    int
	Block   uint64
	RoundID uint64
	Event   *TraceEvent
	Message string
}

func (v *InvariantViolation) Error() string {
	evStr := "<none>"
	if v.Event != nil {
		evStr = fmt.Sprintf("%+v", *v.Event)
	}
	return fmt.Sprintf(
		"INVARIANT VIOLATION seed=%d week=%d block=%d round=%d: %s\noffending event: %s",
		v.Seed, v.Week, v.Block, v.RoundID, v.Message, evStr,
	)
}

// Ledger tracks, per LOGICAL actor (spreader sub-accounts roll up under the
// spreader's logical name), total staked and total received (claim +
// reclaim payouts) across the whole simulation — the basis for the
// per-actor P&L report and the global conservation check.
type Ledger struct {
	staked      map[string]*big.Int
	received    map[string]*big.Int
	role        map[string]string
	subToLogic  map[string]string // sub-account -> logical actor name
	totalSwept  *big.Int          // Σ amounts swept to the DHF, across all rounds
	roundsOwed0 int               // rounds confirmed fully drained (owed==0) at end
}

func NewLedger() *Ledger {
	return &Ledger{
		staked:     map[string]*big.Int{},
		received:   map[string]*big.Int{},
		role:       map[string]string{},
		subToLogic: map[string]string{},
		totalSwept: big.NewInt(0),
	}
}

// RegisterActor declares a logical actor (and, for multi-account actors like
// spreaders, its sub-accounts) up front so P&L rolls up correctly.
func (l *Ledger) RegisterActor(logicalName, role string, accounts ...string) {
	l.role[logicalName] = role
	if _, ok := l.staked[logicalName]; !ok {
		l.staked[logicalName] = big.NewInt(0)
		l.received[logicalName] = big.NewInt(0)
	}
	if len(accounts) == 0 {
		l.subToLogic[logicalName] = logicalName
	}
	for _, a := range accounts {
		l.subToLogic[a] = logicalName
	}
}

func (l *Ledger) logicalOf(acct string) string {
	if n, ok := l.subToLogic[acct]; ok {
		return n
	}
	return acct
}

func (l *Ledger) RecordStake(acct string, amt *big.Int) {
	name := l.logicalOf(acct)
	if _, ok := l.staked[name]; !ok {
		l.staked[name] = big.NewInt(0)
	}
	l.staked[name].Add(l.staked[name], amt)
}

func (l *Ledger) RecordReceived(acct string, amt *big.Int) {
	name := l.logicalOf(acct)
	if _, ok := l.received[name]; !ok {
		l.received[name] = big.NewInt(0)
	}
	l.received[name].Add(l.received[name], amt)
}

func (l *Ledger) RecordSwept(amt *big.Int) {
	l.totalSwept.Add(l.totalSwept, amt)
}

// PnL returns received - staked for a logical actor.
func (l *Ledger) PnL(name string) *big.Int {
	s := l.staked[name]
	r := l.received[name]
	if s == nil {
		s = big.NewInt(0)
	}
	if r == nil {
		r = big.NewInt(0)
	}
	return new(big.Int).Sub(r, s)
}

// Names returns every logical actor name registered, in a stable order isn't
// guaranteed (map iteration) — callers that need determinism should sort.
func (l *Ledger) Names() []string {
	out := make([]string, 0, len(l.staked))
	for n := range l.staked {
		out = append(out, n)
	}
	return out
}

func (l *Ledger) TotalStaked() *big.Int {
	total := big.NewInt(0)
	for _, v := range l.staked {
		total.Add(total, v)
	}
	return total
}

func (l *Ledger) TotalReceived() *big.Int {
	total := big.NewInt(0)
	for _, v := range l.received {
		total.Add(total, v)
	}
	return total
}

// GlobalConservationCheck asserts Σ staked == Σ received + Σ swept exactly —
// the top-level "nothing created, nothing destroyed" check across the ENTIRE
// simulation (every round, every actor, every DHF sweep).
func (l *Ledger) GlobalConservationCheck() error {
	in := l.TotalStaked()
	out := new(big.Int).Add(l.TotalReceived(), l.totalSwept)
	if in.Cmp(out) != 0 {
		return fmt.Errorf("GLOBAL CONSERVATION VIOLATED: Σ staked %s != Σ received %s + Σ swept %s (= %s); diff %s",
			in, l.TotalReceived(), l.totalSwept, out, new(big.Int).Sub(in, out))
	}
	return nil
}

// ---------------------------------------------------------------------------
// Per-round invariant checks — all reading ONLY through the public
// market.Store interface + this package's RoundView/OutcomePool helpers,
// exactly as a real off-chain observer would.
// ---------------------------------------------------------------------------

// checkPoolConservation asserts pool == Σ outcomePool[k], the structural
// invariant market/bet.go's doc comment states RecordBet must maintain at
// every step.
func checkPoolConservation(s market.Store, id uint64, n int) error {
	rv := ReadRound(s, id)
	sum := big.NewInt(0)
	for k := 0; k < n; k++ {
		sum.Add(sum, OutcomePool(s, id, k))
	}
	if rv.Pool.Cmp(sum) != 0 {
		return fmt.Errorf("round %d: pool %s != Σ outcomePool %s", id, rv.Pool, sum)
	}
	return nil
}

// checkNoOverpay asserts a running per-round paid total never exceeds the
// payable ceiling (distributable==pool for a zero-rake settle, or pool for a
// void).
func checkNoOverpay(ceiling, paidSoFar *big.Int, id uint64) error {
	if paidSoFar.Cmp(ceiling) > 0 {
		return fmt.Errorf("round %d: Σ paid %s > ceiling %s (INSOLVENT — overpaid)", id, paidSoFar, ceiling)
	}
	return nil
}

// checkFinalDrain asserts a resolved round's `owed` escrow reads exactly 0
// once every claim/reclaim/sweep that will ever happen for it has happened —
// "everyone made whole to the base unit" for that specific round.
func checkFinalDrain(s market.Store, id uint64) error {
	rv := ReadRound(s, id)
	if !rv.Exists || (rv.State != market.StateSettled && rv.State != market.StateVoid) {
		return fmt.Errorf("round %d: checkFinalDrain called on an unresolved round (state=%q)", id, rv.State)
	}
	if rv.Owed == nil || rv.Owed.Sign() != 0 {
		return fmt.Errorf("round %d (%s): owed escrow = %s, want exactly 0 after full drain (funds stuck)", id, rv.State, rv.Owed)
	}
	return nil
}
