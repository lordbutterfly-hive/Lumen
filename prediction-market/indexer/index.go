package indexer

import (
	"math/big"
	"sort"
	"sync"
)

// roundData is one round's folded event state.
type roundData struct {
	id      uint64
	creator string // from ev:round_created "by"; "" if round_created was never observed (e.g. cursor started mid-stream)

	resolved    bool
	state       string // StateSettled | StateVoid; "" while unresolved
	winner      int
	winnerValid bool // true only when state==StateSettled (see ResolvedEvent doc)
	voidReason  string

	totalBets *big.Int // Σ every ev:bet amount for this round, all accounts, all outcomes

	bettors map[string]struct{} // distinct accounts with >=1 ev:bet in this round

	// stakeByAcct[acct][outcome] = Σ amounts that account bet on that outcome
	// in this round (an account can bet the same outcome more than once; see
	// index_test.go's TestIndexDistinctBettorCount).
	stakeByAcct map[string]map[int]*big.Int
	// stakeTotalByAcct[acct] = Σ across all outcomes, cached for MyPositions.
	stakeTotalByAcct map[string]*big.Int

	// claims[acct], present iff that account has an ev:claim for this round.
	claims map[string]claimData
}

type claimData struct {
	payout *big.Int
	asset  string
}

func newRoundData(id uint64) *roundData {
	return &roundData{
		id:               id,
		totalBets:        big.NewInt(0),
		bettors:          make(map[string]struct{}),
		stakeByAcct:      make(map[string]map[int]*big.Int),
		stakeTotalByAcct: make(map[string]*big.Int),
		claims:           make(map[string]claimData),
	}
}

// Stats reports Index's own health/observability counters — how many raw
// events have been folded, and how many were skipped and why. A real
// deployment should alert if Malformed/Unknown grows unexpectedly (either
// means this package is out of sync with what the contract actually emits).
type Stats struct {
	Ingested   int // events successfully parsed and folded (known kinds only)
	Unknown    int // events with a well-formed envelope but an unrecognized "ev" (skipped, not an error)
	Malformed  int // events that failed to parse as JSON / had no "ev" field (skipped, not an error)
	LastCursor Cursor
}

// Index is the aggregating fold over the contract's event stream: the
// read-side this whole package exists to build (package doc). All exported
// methods are safe for concurrent use; Ingest/Poll may run from a single
// background poller goroutine while query methods (RoundSummary, Bettors,
// MyPositions, MyUnclaimed, HouseTaken) are called concurrently from
// request-handling goroutines (see http.go).
type Index struct {
	mu sync.RWMutex

	rounds map[uint64]*roundData
	// acctRounds[acct] = set of round ids that account has an ev:bet in,
	// kept for O(bets-by-that-account) MyPositions/MyUnclaimed instead of an
	// O(all rounds) scan.
	acctRounds map[string]map[uint64]struct{}

	houseTaken map[string]*big.Int // asset -> Σ ev:house_paid amount

	stats Stats
}

// NewIndex returns an empty Index ready for Ingest/Poll.
func NewIndex() *Index {
	return &Index{
		rounds:     make(map[uint64]*roundData),
		acctRounds: make(map[string]map[uint64]struct{}),
		houseTaken: make(map[string]*big.Int),
	}
}

func (ix *Index) round(id uint64) *roundData {
	r, ok := ix.rounds[id]
	if !ok {
		r = newRoundData(id)
		ix.rounds[id] = r
	}
	return r
}

// Ingest folds a batch of raw events into the index, in order. It NEVER
// returns an error for a bad individual event — malformed JSON or an
// unrecognized "ev" is counted in Stats and skipped, exactly per ParseEvent's
// documented graceful-degradation contract (events.go), so one corrupt log
// line can never wedge the whole indexer. Events must be presented in
// on-chain emission order (see EventSource's ordering contract in source.go)
// — Ingest itself does not re-sort.
func (ix *Index) Ingest(events []RawEvent) {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	for _, raw := range events {
		ix.ingestOneLocked(raw)
	}
}

func (ix *Index) ingestOneLocked(raw RawEvent) {
	ev, err := ParseEvent(raw)
	if err != nil {
		ix.stats.Malformed++
		return
	}
	if ev.Unknown {
		ix.stats.Unknown++
		return
	}

	// Exactly ONE of Ingested/Malformed is incremented below, once, after
	// folding is known to have succeeded or failed — never both. (An earlier
	// version incremented Ingested unconditionally up front and then ALSO
	// incremented Malformed inside the KindBet/KindClaim/KindHousePaid cases
	// on a bad amount string, double-counting that single event into two
	// buckets; caught by TestIndex_UnknownAndMalformedEventsDontWedgeIngestion.)
	if ix.foldKnownEventLocked(ev) {
		ix.stats.Ingested++
	} else {
		ix.stats.Malformed++
	}
}

// foldKnownEventLocked applies one already-parsed, known-kind Event to
// round/account state. Returns false (without partially applying anything
// for THAT event) if a field that should have been a valid decimal amount
// wasn't — the only way a well-formed-JSON, known-kind event can still fail
// to fold.
func (ix *Index) foldKnownEventLocked(ev Event) bool {
	switch ev.Kind {
	case KindRoundCreated:
		p := ev.RoundCreated
		r := ix.round(p.RoundID)
		r.creator = p.By

	case KindBet:
		p := ev.Bet
		amount, ok := new(big.Int).SetString(p.Amount, 10)
		if !ok || amount.Sign() < 0 {
			// A malformed/negative amount from OUR OWN contract's log format
			// should never happen (main.go's Bet handler only ever logs
			// amount.String() off a validated non-negative *big.Int) — but
			// fail closed rather than corrupt totals with a bogus number.
			return false
		}
		r := ix.round(p.RoundID)
		r.bettors[p.Acct] = struct{}{}
		r.totalBets.Add(r.totalBets, amount)

		if r.stakeByAcct[p.Acct] == nil {
			r.stakeByAcct[p.Acct] = make(map[int]*big.Int)
		}
		if cur, ok := r.stakeByAcct[p.Acct][p.Outcome]; ok {
			cur.Add(cur, amount)
		} else {
			r.stakeByAcct[p.Acct][p.Outcome] = new(big.Int).Set(amount)
		}
		if cur, ok := r.stakeTotalByAcct[p.Acct]; ok {
			cur.Add(cur, amount)
		} else {
			r.stakeTotalByAcct[p.Acct] = new(big.Int).Set(amount)
		}

		if ix.acctRounds[p.Acct] == nil {
			ix.acctRounds[p.Acct] = make(map[uint64]struct{})
		}
		ix.acctRounds[p.Acct][p.RoundID] = struct{}{}

	case KindResolved:
		p := ev.Resolved
		r := ix.round(p.RoundID)
		r.resolved = true
		r.state = p.State
		r.winner = p.Winner
		r.winnerValid = p.State == StateSettled
		r.voidReason = p.Reason // "" for settled, per Settle's doc

	case KindVoided:
		p := ev.Voided
		r := ix.round(p.RoundID)
		r.resolved = true
		r.state = StateVoid
		r.winnerValid = false
		r.voidReason = p.Reason

	case KindClaim:
		p := ev.Claim
		payout, ok := new(big.Int).SetString(p.Payout, 10)
		if !ok || payout.Sign() < 0 {
			return false
		}
		r := ix.round(p.RoundID)
		r.claims[p.Acct] = claimData{payout: payout, asset: p.Asset}

	case KindHousePaid:
		p := ev.HousePaid
		amount, ok := new(big.Int).SetString(p.Amount, 10)
		if !ok || amount.Sign() < 0 {
			return false
		}
		if cur, ok := ix.houseTaken[p.Asset]; ok {
			cur.Add(cur, amount)
		} else {
			ix.houseTaken[p.Asset] = new(big.Int).Set(amount)
		}
	}
	return true
}

// Poll pulls one batch of events from src (starting after Stats().LastCursor)
// and Ingests them, advancing the stored cursor. Returns how many raw events
// were fetched in this call (ingested + skipped, i.e. len(events) from the
// source) so a caller can loop `for { n, err := ix.Poll(src, 500); if n==0
// {break} }` to drain a source, exactly the pattern demo.go uses.
func (ix *Index) Poll(src EventSource, limit int) (int, error) {
	ix.mu.RLock()
	cursor := ix.stats.LastCursor
	ix.mu.RUnlock()

	events, next, err := src.Events(cursor, limit)
	if err != nil {
		return 0, err
	}
	ix.Ingest(events)

	ix.mu.Lock()
	ix.stats.LastCursor = next
	ix.mu.Unlock()

	return len(events), nil
}

// Stats returns a snapshot of Index's ingestion counters.
func (ix *Index) Stats() Stats {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	return ix.stats
}

// ----------------------------------------------------------------------
// Query surface
// ----------------------------------------------------------------------

// RoundSummary is the aggregate view of one round the contract itself cannot
// answer (DUMB-QUESTIONS E5): creator, resolution state, winner, distinct
// bettor count, and total staked.
type RoundSummary struct {
	RoundID     uint64
	Creator     string // "" if ev:round_created was never observed for this id
	Resolved    bool
	State       string // "open" (not yet resolved) | StateSettled | StateVoid
	Winner      int
	WinnerValid bool // false when unresolved OR void (see ResolvedEvent doc — winner==0 is ambiguous otherwise)
	VoidReason  string
	Bettors     int      // distinct accounts with an ev:bet in this round
	TotalBets   *big.Int // Σ every ev:bet amount, all accounts, all outcomes
}

const stateOpen = "open" // mirrors market.StateOpen (../market/params.go) — see events.go's coupling note

// RoundSummary returns the aggregate for roundID, or ok=false if this Index
// has never observed ANY event for that round id (neither round_created nor
// a bet — e.g. it doesn't exist, or its events haven't been ingested yet).
func (ix *Index) RoundSummary(roundID uint64) (RoundSummary, bool) {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	r, ok := ix.rounds[roundID]
	if !ok {
		return RoundSummary{}, false
	}
	state := stateOpen
	if r.resolved {
		state = r.state
	}
	return RoundSummary{
		RoundID:     roundID,
		Creator:     r.creator,
		Resolved:    r.resolved,
		State:       state,
		Winner:      r.winner,
		WinnerValid: r.winnerValid,
		VoidReason:  r.voidReason,
		Bettors:     len(r.bettors),
		TotalBets:   new(big.Int).Set(r.totalBets),
	}, true
}

// Bettors returns the distinct-account count for roundID (0 if the round is
// unknown or has no bets yet). Equivalent to RoundSummary(id).Bettors but
// avoids building the rest of the struct when only this is needed (this is
// exactly the number the mock frontend hardcodes as "34" — types.ts's
// RoundState.bettors — which this call is meant to replace for real).
func (ix *Index) Bettors(roundID uint64) int {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	r, ok := ix.rounds[roundID]
	if !ok {
		return 0
	}
	return len(r.bettors)
}

// PositionSummary is one account's stake + claim state in one round.
type PositionSummary struct {
	RoundID        uint64
	StakeByOutcome map[int]*big.Int // outcome index -> Σ staked by this account on it
	TotalStaked    *big.Int
	RoundResolved  bool
	RoundState     string // "open" | StateSettled | StateVoid, as of query time
	Claimed        bool
	ClaimPayout    *big.Int // nil unless Claimed
	ClaimAsset     string   // "" unless Claimed
}

// MyPositions returns every round `acct` has placed at least one ev:bet in,
// each with their stake broken down by outcome, sorted ascending by round id
// for deterministic output.
func (ix *Index) MyPositions(acct string) []PositionSummary {
	ix.mu.RLock()
	defer ix.mu.RUnlock()

	ids := sortedRoundIDs(ix.acctRounds[acct])
	out := make([]PositionSummary, 0, len(ids))
	for _, id := range ids {
		r := ix.rounds[id]
		out = append(out, ix.positionSummaryLocked(r, acct))
	}
	return out
}

func (ix *Index) positionSummaryLocked(r *roundData, acct string) PositionSummary {
	state := stateOpen
	if r.resolved {
		state = r.state
	}
	stakeByOutcome := make(map[int]*big.Int, len(r.stakeByAcct[acct]))
	for outcome, amt := range r.stakeByAcct[acct] {
		stakeByOutcome[outcome] = new(big.Int).Set(amt)
	}
	total := big.NewInt(0)
	if t, ok := r.stakeTotalByAcct[acct]; ok {
		total = new(big.Int).Set(t)
	}

	ps := PositionSummary{
		RoundID:        r.id,
		StakeByOutcome: stakeByOutcome,
		TotalStaked:    total,
		RoundResolved:  r.resolved,
		RoundState:     state,
	}
	if c, ok := r.claims[acct]; ok {
		ps.Claimed = true
		ps.ClaimPayout = new(big.Int).Set(c.payout)
		ps.ClaimAsset = c.asset
	}
	return ps
}

// MyUnclaimed returns the round ids where `acct` bet (bet-set) AND the round
// is resolved (settled or void) AND `acct` has NOT emitted an ev:claim for it
// (bet-set minus claim-set) — sorted ascending. This is the off-chain
// "your claims history" / D7-visibility the frontend needs (task spec, and
// DUMB-QUESTIONS D7: a winner who never claims is stranded forever with no
// on-chain reminder — this is the only signal that a user has money waiting).
//
// Deliberately win/loss-agnostic: a LOSING bettor on a settled round who
// hasn't called claim() also shows up here, because claim.go's own contract
// (../market/claim.go doc: "A zero payout is still a successful claim") means
// "resolved but never claimed" is meaningful regardless of outcome — the
// bet-set/claim-set difference is exactly what the task spec defines.
func (ix *Index) MyUnclaimed(acct string) []uint64 {
	ix.mu.RLock()
	defer ix.mu.RUnlock()

	ids := sortedRoundIDs(ix.acctRounds[acct])
	out := make([]uint64, 0, len(ids))
	for _, id := range ids {
		r := ix.rounds[id]
		if !r.resolved {
			continue
		}
		if _, claimed := r.claims[acct]; claimed {
			continue
		}
		out = append(out, id)
	}
	return out
}

// HouseTaken returns Σ ev:house_paid amounts for `asset` across every
// WithdrawFees sweep this Index has observed. Zero (not nil) if the asset has
// never appeared.
func (ix *Index) HouseTaken(asset string) *big.Int {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	if v, ok := ix.houseTaken[asset]; ok {
		return new(big.Int).Set(v)
	}
	return big.NewInt(0)
}

func sortedRoundIDs(set map[uint64]struct{}) []uint64 {
	ids := make([]uint64, 0, len(set))
	for id := range set {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids
}
