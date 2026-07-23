package indexer

import (
	"math/big"
	"sort"
	"strconv"
	"sync"
)

// index.go — the aggregating fold over a creator market's event stream: the
// read-side this whole package exists to build. Contract state
// (SPEC-CREATOR-KEYS.md §1.5) holds only the CURRENT escrow set and CURRENT
// balances; it has no memory of a resolved ask, a past face price, or a
// former holder. Everything queryable here is a REPLAY of ../core/events.go's
// twelve event shapes, nothing more.
//
// Deliberately NOT provided anywhere in this file, or reachable through it:
// any aggregate of amounts moved (Σ prepaid, Σ asked, Σ transferred) as a
// "volume" statistic. SPEC-CREATOR-KEYS.md §1.5/§2.0.2/§2.8: "Never
// displayed anywhere: trading volume. Wash trading buys a fake track
// record, and volume is the metric that pays for it." If a future caller
// wants a volume figure, they must compute it themselves from
// EventHistory's raw amounts and add it deliberately (their own scope,
// their own decision) — this package will not compute or expose it as a
// first-class query, on purpose, to keep it out of easy reach of a ranking
// or discovery surface that could reward wash trading.
//
// Also deliberately NOT authoritative for: Phase/status, live supply, live
// reserve, or the refund floor (RefundPrice). SPEC §2.5 routes those
// through a direct chain read (getStateByKeys) — this package's
// MarketSummary below is an event-log-derived snapshot for AUDIT/CROSS-CHECK
// only, and says so.

// escrowEntry tracks one PENDING-or-resolved ask, keyed by (creator, seq)
// via marketData.escrows. Only what's needed to compute a response time
// later is retained.
type escrowEntry struct {
	asker      string
	askedBlock uint64
	resolved   bool
}

// DeliveryOutcome is one resolved ask (answered or reclaimed) — the unit
// the delivery record (task spec item 1) is built from. A resolved ask
// never appears twice: ask.go's own status machine PENDING -> ANSWERED |
// RECLAIMED is one-way, by construction.
type DeliveryOutcome struct {
	Seq            uint64
	Asker          string
	AskedBlock     uint64
	ResolvedBlock  uint64
	Answered       bool   // true=answered (kept), false=reclaimed (missed)
	ResponseBlocks uint64 // ResolvedBlock-AskedBlock; meaningful only when Answered
}

// marketData is one creator's folded state.
type marketData struct {
	creator string

	// lastFace/lastCap/closed are a REPLAY of registered/faceChanged/
	// capChanged/closed events — audit/cross-check only, never authoritative
	// (see file doc and MarketSummary's own doc).
	lastFace *big.Int
	lastCap  *big.Int
	closed   bool

	// balances[holder] = current LIQUID credits (matches contract's own
	// kBal semantics exactly: I3, "supply == Σ bal + credits currently
	// escrowed" — a credit inside an open escrow is NOT in this map until
	// Answer/Reclaim resolves it back into one).
	balances map[string]*big.Int

	// escrows[seq] tracks every ask this Index has seen asked, whether or
	// not it has since resolved.
	escrows map[uint64]*escrowEntry

	// deliveryOutcomes holds every RESOLVED ask, in resolution order — the
	// primitive DeliveryHistory/DeliveryRecord are built from.
	deliveryOutcomes []DeliveryOutcome

	// commissionBookedHbd/commissionReturnedHbd (M1/M4 fix, 2026-07-21) are
	// this creator's own lifetime replay of the HBD commission legs Answer
	// books to the GLOBAL treasury and Reclaim hands back to askers,
	// respectively — the per-market breakdown feeding Index.TreasuryHbd/
	// Index.ReclaimOutflowHbd's package-wide totals (see those methods'
	// doc for why the totals themselves must be global, not per-market:
	// kTreasury() is a single global key, keys.go:15). Deliberately NEVER
	// reset by a re-registration (see foldKnownEventLocked's KindRegistered
	// case) — unlike deliveryOutcomes/escrows/balances, these are lifetime
	// financial totals for this creator's account, not a reputation signal,
	// and zeroing them would make this creator's own commission history
	// stop reconciling with money that is still sitting in the (also
	// never-reset) global treasury.
	commissionBookedHbd   *big.Int
	commissionReturnedHbd *big.Int

	// history is every RawEvent folded for this creator, in ingestion
	// (== on-chain emission) order — the audit surface (task spec item 3).
	// NEVER reset by a re-registration (see foldKnownEventLocked's
	// KindRegistered case) — this is the permanent record across every
	// incarnation, by design.
	history []RawEvent
}

func newMarketData(creator string) *marketData {
	return &marketData{
		creator:               creator,
		balances:              make(map[string]*big.Int),
		escrows:               make(map[uint64]*escrowEntry),
		commissionBookedHbd:   big.NewInt(0),
		commissionReturnedHbd: big.NewInt(0),
	}
}

func (m *marketData) bal(holder string) *big.Int {
	if v, ok := m.balances[holder]; ok {
		return v
	}
	return big.NewInt(0)
}

func (m *marketData) addBal(holder string, delta *big.Int) {
	m.balances[holder] = new(big.Int).Add(m.bal(holder), delta)
}

func (m *marketData) subBal(holder string, delta *big.Int) {
	m.balances[holder] = new(big.Int).Sub(m.bal(holder), delta)
}

// Stats reports Index's own health/observability counters. A real
// deployment should alert if Malformed/Unknown grows unexpectedly (either
// means this package is out of sync with what core/events.go actually
// emits, or upstream data is corrupt).
type Stats struct {
	Ingested   int // events successfully parsed and folded (known kinds only)
	Unknown    int // well-formed envelope, unrecognized "ev" (skipped, not an error)
	Malformed  int // failed to parse as JSON / no "ev" field / a known kind with an unparseable amount (skipped, not an error)
	Duplicate  int // (OutputID,Seq) already ingested — see Ingest's idempotency doc; skipped without touching Malformed/Unknown/Ingested
	LastCursor Cursor
}

// Index is the aggregating fold over one contract's full event stream
// (potentially many creator markets at once — every query below is scoped
// by `creator`). All exported methods are safe for concurrent use;
// Ingest/Poll may run from a single background poller goroutine while query
// methods are called concurrently from request-handling goroutines.
type Index struct {
	mu sync.RWMutex

	markets map[string]*marketData

	// seenKeys is the (OutputID,Seq) de-duplication set — see Ingest's doc
	// for why double-delivery of the exact same log line must be a no-op,
	// not a double-count.
	seenKeys map[string]struct{}

	// treasuryHbd/reclaimOutflowHbd (M4 fix, 2026-07-21) are GLOBAL running
	// totals across every creator market this Index has observed — see
	// TreasuryHbd/ReclaimOutflowHbd's own doc below for why these are
	// package-wide rather than per-market (kTreasury() is a single global
	// key shared by every market, keys.go:15 — unlike everything else this
	// package tracks, which is genuinely per-creator).
	treasuryHbd       *big.Int
	reclaimOutflowHbd *big.Int

	stats Stats
}

// NewIndex returns an empty Index ready for Ingest/Poll.
func NewIndex() *Index {
	return &Index{
		markets:           make(map[string]*marketData),
		seenKeys:          make(map[string]struct{}),
		treasuryHbd:       big.NewInt(0),
		reclaimOutflowHbd: big.NewInt(0),
	}
}

func (ix *Index) market(creator string) *marketData {
	m, ok := ix.markets[creator]
	if !ok {
		m = newMarketData(creator)
		ix.markets[creator] = m
	}
	return m
}

func dedupKey(raw RawEvent) string {
	return raw.OutputID + "#" + strconv.Itoa(raw.Seq)
}

// Ingest folds a batch of raw events into the index, in order.
//
// IDEMPOTENT under exact redelivery: each event is identified by
// (OutputID, Seq) — a stable identity for "this exact on-chain log line,"
// never reconstructed or guessed. A RawEvent whose (OutputID,Seq) has
// already been folded is skipped entirely (counted in Stats.Duplicate, not
// re-applied) rather than folded again. This is what makes a poller-restart
// safe: if a crash happens after fetching a batch but before persisting the
// advanced cursor, the next run re-fetches and re-Ingests an overlapping
// batch, and the overlap is a genuine no-op rather than double-counted
// balances/response-times. See index_test.go's
// TestIndex_DoubleIngestIsIdempotent,
// TestIndex_DeterministicReplayFreshInstances, and
// TestIndex_PrefixThenRestEqualsWhole for the three properties this
// guarantees together (task spec: "replaying the same event stream twice
// yields identical state, and replaying a prefix then the rest equals
// replaying the whole").
//
// Never returns an error for a bad individual event — malformed JSON or an
// unrecognized "ev" is counted in Stats and skipped, per ParseEvent's
// documented graceful-degradation contract, so one corrupt log line can
// never wedge the whole indexer. Events must be presented in on-chain
// emission order (EventSource's ordering contract, source.go) — Ingest
// itself does not re-sort.
func (ix *Index) Ingest(events []RawEvent) {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	for _, raw := range events {
		ix.ingestOneLocked(raw)
	}
}

func (ix *Index) ingestOneLocked(raw RawEvent) {
	key := dedupKey(raw)
	if _, dup := ix.seenKeys[key]; dup {
		ix.stats.Duplicate++
		return
	}
	ix.seenKeys[key] = struct{}{}

	ev, err := ParseEvent(raw)
	if err != nil {
		ix.stats.Malformed++
		return
	}
	if ev.Unknown {
		ix.stats.Unknown++
		return
	}
	if ix.foldKnownEventLocked(ev, raw) {
		ix.stats.Ingested++
	} else {
		ix.stats.Malformed++
	}
}

// parseAmount parses a base-10, non-negative decimal string exactly like
// core/money.go's own parseMoney convention — fail closed (ok=false) rather
// than silently treating garbage as zero, so a corrupt amount from OUR OWN
// event schema (which should never happen — core/events.go only ever emits
// *big.Int.String() output) is caught rather than corrupting a running
// balance total.
func parseAmount(s string) (*big.Int, bool) {
	v, ok := new(big.Int).SetString(s, 10)
	if !ok || v.Sign() < 0 {
		return nil, false
	}
	return v, true
}

func satSub(a, b uint64) uint64 {
	if a < b {
		return 0
	}
	return a - b
}

// foldKnownEventLocked applies one already-parsed, known-kind Event to
// market state. Returns false (without applying ANYTHING for THAT event —
// no balance change, no history append) if ANY of its documented
// money-shaped fields fails to parse as a non-negative base-10 decimal —
// deliberately not just the ones this fold happens to use arithmetically.
// A well-behaved core/events.go emitter never produces a field that fails
// this (every amount is *big.Int.String() output — see events.go's file
// doc), so a failure here is always upstream corruption, and validating
// every amount field (not only the ones this fold consumes) keeps a
// corrupt audit-only field (e.g. a garbled `rate` on an otherwise-valid
// ask) from silently entering EventHistory — the audit surface (task spec
// item 3) should never contain a record this package itself couldn't
// fully verify. See index_test.go's
// TestIndex_UnknownAndMalformedEventsDontWedgeIngestion, which specifically
// covers a corrupt field that ISN'T the one used in balance arithmetic.
func (ix *Index) foldKnownEventLocked(ev Event, raw RawEvent) bool {
	switch ev.Kind {
	case KindRegistered:
		p := ev.Registered
		face, ok1 := parseAmount(p.Face)
		cap_, ok2 := parseAmount(p.Cap)
		feePaid, ok3 := parseAmount(p.FeePaid) // M4 fix: folded into ix.treasuryHbd below (was audit-only)
		if !ok1 || !ok2 || !ok3 {
			return false
		}
		m := ix.market(p.Creator)

		// M5 fix (2026-07-21): a "registered" event for a market this Index
		// has already observed go `closed` is a legal CLOSED->ACTIVE
		// re-registration — core's own duplicate guard (market.go's
		// Register) only ever accepts a Register call when kState is ""
		// (never registered) or StateClosed, so this can ONLY mean a NEW
		// incarnation, never a correction to the old one (SPEC §1.7.5: "a
		// creator returning later re-registers and starts fresh"). Before
		// this fix `closed` was a one-way latch — nothing ever cleared it —
		// so a returning creator showed as permanently CLOSED and their
		// delivery record kept the previous incarnation's missed marks
		// forever, even though the chain had genuinely moved them back to
		// ACTIVE.
		//
		// Reset every PER-INCARNATION counter so the returning creator
		// starts fresh, exactly like a brand-new market would:
		//   - deliveryOutcomes: the delivery record itself (task spec item
		//     1) — this is the specific data M5 names ("inherits the old
		//     incarnation's missed marks").
		//   - escrows: clears any stale PENDING entries from the old
		//     incarnation. On a healthy chain there should be none left —
		//     Register's own duplicate guard cannot pass while any escrow
		//     keeps kSupply above zero (H1/refund.go's CloseIfDrained) — so
		//     this is defense-in-depth against index/chain drift, not a
		//     correction of an expected case.
		//   - balances: same defense-in-depth reasoning — CLOSED implies
		//     kSupply==0, which (I3) implies every balance is already zero
		//     (refund.go: "has kBal == 0 for everyone"), so this is a
		//     provable no-op on a healthy chain, not a divergence from it.
		//
		// Deliberately NEVER reset: history (the permanent, append-only
		// audit log across every incarnation — marketData's own doc) and
		// commissionBookedHbd/commissionReturnedHbd (lifetime financial
		// totals, not a reputation signal — see marketData's own doc on
		// those two fields for why).
		if m.closed {
			m.closed = false
			m.deliveryOutcomes = nil
			m.escrows = make(map[uint64]*escrowEntry)
			m.balances = make(map[string]*big.Int)
		}

		m.lastFace = face
		m.lastCap = cap_
		ix.treasuryHbd = new(big.Int).Add(ix.treasuryHbd, feePaid)
		m.history = append(m.history, raw)

	case KindRenewed:
		p := ev.Renewed
		// M4 fix: folded into ix.treasuryHbd below — Renew books the full
		// `paid` amount to the same global kTreasury() key Register's
		// feePaid and Answer's commissionHbd do (market.go's Renew: "same
		// accrual key and full-amount-booked convention as Register's
		// registration fee and Ask's commission leg"). Renewed still has no
		// balance/delivery effect (see EvRenewed's doc) — this is purely a
		// solvency-total contribution.
		paid, ok := parseAmount(p.Paid)
		if !ok {
			return false
		}
		m := ix.market(p.Creator)
		ix.treasuryHbd = new(big.Int).Add(ix.treasuryHbd, paid)
		m.history = append(m.history, raw)

	case KindFaceChanged:
		p := ev.FaceChanged
		if _, ok := parseAmount(p.OldFace); !ok { // audit-only
			return false
		}
		newFace, ok := parseAmount(p.NewFace)
		if !ok {
			return false
		}
		m := ix.market(p.Creator)
		m.lastFace = newFace
		m.history = append(m.history, raw)

	case KindCapChanged:
		p := ev.CapChanged
		if _, ok := parseAmount(p.OldCap); !ok { // audit-only
			return false
		}
		newCap, ok := parseAmount(p.NewCap)
		if !ok {
			return false
		}
		m := ix.market(p.Creator)
		m.lastCap = newCap
		m.history = append(m.history, raw)

	case KindPrepaid:
		p := ev.Prepaid
		if _, ok := parseAmount(p.HbdPaid); !ok { // audit-only (PAR means it's always == CreditsMinted, but validated independently anyway)
			return false
		}
		credits, ok := parseAmount(p.CreditsMinted)
		if !ok {
			return false
		}
		m := ix.market(p.Creator)
		m.addBal(p.Actor, credits)
		m.history = append(m.history, raw)

	case KindTransferred:
		p := ev.Transferred
		amount, ok := parseAmount(p.Amount)
		if !ok {
			return false
		}
		m := ix.market(p.Creator)
		m.subBal(p.Actor, amount)
		m.addBal(p.To, amount)
		m.history = append(m.history, raw)

	case KindAsked:
		p := ev.Asked
		creditsSpent, ok := parseAmount(p.CreditsSpent)
		if !ok {
			return false
		}
		if _, ok := parseAmount(p.CommissionHbd); !ok { // audit-only
			return false
		}
		if _, ok := parseAmount(p.Rate); !ok { // audit-only
			return false
		}
		m := ix.market(p.Creator)
		m.subBal(p.Actor, creditsSpent)
		m.escrows[p.Seq] = &escrowEntry{asker: p.Actor, askedBlock: p.Block}
		m.history = append(m.history, raw)

	case KindAnswered:
		p := ev.Answered
		creditsToCreator, ok1 := parseAmount(p.CreditsToCreator)
		commissionHbd, ok2 := parseAmount(p.CommissionHbd) // M4 fix
		if !ok1 || !ok2 {
			return false
		}
		m := ix.market(p.Creator)
		m.addBal(p.Creator, creditsToCreator)
		m.commissionBookedHbd = new(big.Int).Add(m.commissionBookedHbd, commissionHbd)
		ix.treasuryHbd = new(big.Int).Add(ix.treasuryHbd, commissionHbd)
		if esc, known := m.escrows[p.Seq]; known && !esc.resolved {
			esc.resolved = true
			m.deliveryOutcomes = append(m.deliveryOutcomes, DeliveryOutcome{
				Seq: p.Seq, Asker: esc.asker, AskedBlock: esc.askedBlock,
				ResolvedBlock: p.Block, Answered: true,
				ResponseBlocks: satSub(p.Block, esc.askedBlock),
			})
		}
		// else: an answered event with no matching asked event in this
		// Index's own history (e.g. a poller/cursor that started mid-stream).
		// The balance credit above is still applied — it is directly stated
		// by the event itself — but this ask cannot contribute to the
		// response-time distribution since its ask block was never observed.
		// See the handoff report.
		m.history = append(m.history, raw)

	case KindReclaimed:
		p := ev.Reclaimed
		credits, ok1 := parseAmount(p.Credits)
		commissionHbd, ok2 := parseAmount(p.CommissionHbd) // M4 fix
		if !ok1 || !ok2 {
			return false
		}
		m := ix.market(p.Creator)
		m.addBal(p.Actor, credits) // actor == the escrow's own asker (Reclaim's own auth check)
		m.commissionReturnedHbd = new(big.Int).Add(m.commissionReturnedHbd, commissionHbd)
		ix.reclaimOutflowHbd = new(big.Int).Add(ix.reclaimOutflowHbd, commissionHbd)
		if esc, known := m.escrows[p.Seq]; known && !esc.resolved {
			esc.resolved = true
			m.deliveryOutcomes = append(m.deliveryOutcomes, DeliveryOutcome{
				Seq: p.Seq, Asker: esc.asker, AskedBlock: esc.askedBlock,
				ResolvedBlock: p.Block, Answered: false,
			})
		}
		m.history = append(m.history, raw)

	case KindRefunded:
		p := ev.Refunded
		credits, ok := parseAmount(p.Credits)
		if !ok {
			return false
		}
		if _, ok := parseAmount(p.Payout); !ok { // audit-only; not folded into any running total
			return false
		}
		m := ix.market(p.Creator)
		m.subBal(p.Actor, credits)
		m.history = append(m.history, raw)

	case KindRefundPushed:
		p := ev.RefundPushed
		burned, ok := parseAmount(p.CreditsBurned)
		if !ok {
			return false
		}
		if _, ok := parseAmount(p.Payout); !ok { // audit-only
			return false
		}
		m := ix.market(p.Creator)
		m.subBal(p.Holder, burned)
		m.history = append(m.history, raw)

	case KindClosed:
		p := ev.Closed
		m := ix.market(p.Creator)
		m.closed = true // idempotent set — a duplicate "closed" (core.CloseIfDrained's own documented idempotent return) is a harmless repeat
		m.history = append(m.history, raw)
	}
	return true
}

// Poll pulls one batch of events from src (starting after Stats().LastCursor)
// and Ingests them, advancing the stored cursor. Returns how many raw events
// were fetched in this call (ingested + skipped, i.e. len(events) from the
// source) so a caller can loop `for { n, err := ix.Poll(src, 500); if n==0
// {break} }` to drain a source.
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

// Position returns holder's current LIQUID credit balance for creator's
// market — credits actually in their kBal, matching the contract's own I3
// accounting (escrowed credits belong to the escrow, not the holder, until
// Answer/Reclaim resolves it back into a balance). Zero (never nil) if the
// creator or holder is unknown to this Index.
func (ix *Index) Position(creator, holder string) *big.Int {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	m, ok := ix.markets[creator]
	if !ok {
		return big.NewInt(0)
	}
	return new(big.Int).Set(m.bal(holder))
}

// HolderList returns every account with a CURRENTLY NON-ZERO credit balance
// for creator's market, sorted for determinism. This is the fund-path list
// (task spec: "the keeper needs the holder list to push refunds at
// wind-down") — scoped to non-zero balances deliberately, since
// RefundHolder(creator, holder) on a zero balance is a documented harmless
// no-op (refund.go) but still costs the keeper a wasted transaction;
// serving only real holders keeps a wind-down sweep minimal.
func (ix *Index) HolderList(creator string) []string {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	m, ok := ix.markets[creator]
	if !ok {
		return nil
	}
	out := make([]string, 0, len(m.balances))
	for h, bal := range m.balances {
		if bal.Sign() > 0 {
			out = append(out, h)
		}
	}
	sort.Strings(out)
	return out
}

// DeliveryHistory returns EVERY resolved ask for creator, oldest first — the
// full, ungrouped record. Pending (not-yet-resolved) asks are never
// included.
//
// This is the primitive any windowing scheme should be built on — "the last
// ~12 windows" (SPEC §2.1.A.2) is a PRODUCT decision this package does not
// bake in a single interpretation of (a calendar window? last-N-asks?
// last-N-blocks?); DeliveryRecord below picks the simplest one (last N
// resolved asks) as a ready default, but a caller wanting a different
// windowing rule should slice this slice directly instead.
func (ix *Index) DeliveryHistory(creator string) []DeliveryOutcome {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	m, ok := ix.markets[creator]
	if !ok {
		return nil
	}
	out := make([]DeliveryOutcome, len(m.deliveryOutcomes))
	copy(out, m.deliveryOutcomes)
	return out
}

// DeliveryRecord is the per-creator delivery record (task spec item 1):
// answered count, missed (reclaimed) count, and the response-time
// distribution, over the most recent `window` resolved asks (window<=0
// means "all of history").
//
// M1 fix (2026-07-21 — PRUNED-ADJUDICATION-2026-07-21.md): AnsweredCount/
// MissedCount/ResponseBlocks/DistinctAskers now EXCLUDE any resolved ask
// where the asker was the creator themself (Asker == Creator — a
// "self-deal"). Before this fix a creator could self-answer their own asks
// (cost: the 12% commission on face, e.g. ~12 HBD per 1000 answered) to
// manufacture a flawless delivery record out of thin air, and the record
// carried no signal at all distinguishing that from genuine third-party
// delivery.
//
// THIS IS A DISPLAY-GRADE TRUST HEURISTIC, NOT A CONTRACT GUARANTEE — say
// this every place the record is surfaced. The contract has no way to
// prevent a sybil ask from a fresh/rented account either (a competitor can
// mint "missed" marks onto an honest creator the exact same way an
// attacker manufactures "answered" ones), so self-deal exclusion only ever
// raises the cost of gaming this number, never eliminates it. DistinctAskers
// is exposed specifically so a UI can down-weight a record built from a
// suspiciously small number of distinct funding origins — a record with
// AnsweredCount=1000 and DistinctAskers=2 is a very different signal from
// one with DistinctAskers=1000, and this package deliberately does not
// collapse that distinction into a single number itself (same "expose raw
// data, let the UI decide" convention this file already uses for
// ResponseBlocks/windowing — see this method's own doc below).
type DeliveryRecord struct {
	Creator           string
	AnsweredCount     int
	MissedCount       int
	PendingCount      int      // asked but neither answered nor reclaimed yet — a live gauge, NOT windowed (see doc below), NOT self-deal-filtered (see DeliveryRecord's own method doc)
	ResponseBlocks    []uint64 // one per ANSWERED, non-self-dealt ask in the window, in resolution order; never one for a reclaim (there is no "response time" for an ask nobody answered)
	DistinctAskers    int      // count of distinct non-self-dealt askers contributing to AnsweredCount+MissedCount in this window (M1 fix)
	SelfDealtExcluded int      // count of resolved asks in this window where Asker==Creator, excluded from every field above (M1 fix) — kept visible/auditable rather than silently dropped
}

// DeliveryRecord summarizes DeliveryHistory over the most recent `window`
// resolved asks. AnsweredCount+MissedCount+SelfDealtExcluded always sums to
// min(window, len(DeliveryHistory(creator))) (self-dealt outcomes are still
// counted, just routed to SelfDealtExcluded instead of Answered/Missed —
// see the struct's own M1 doc). PendingCount is deliberately NOT subject to
// `window`, and NOT self-deal-filtered — it is a live "how many outstanding
// right now" gauge, not a historical trend value like answered/missed, so
// windowing or filtering it would not mean anything (a pending self-ask is
// exactly as real a liability against the creator's own future action as
// any other pending ask).
//
// ResponseBlocks is the raw distribution (task spec: "response-time
// distribution (blocks between ask and answer)") — bucketing/histogramming
// it into display form (percentiles, a sparkline, kept/missed marks per
// SPEC §2.1.A.2) is a UI-layer job, not this package's; exposing raw
// ordered data over a pre-aggregated summary number is the same convention
// api.go's DTOs use elsewhere in this package.
func (ix *Index) DeliveryRecord(creator string, window int) DeliveryRecord {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	rec := DeliveryRecord{Creator: creator}
	m, ok := ix.markets[creator]
	if !ok {
		return rec
	}
	for _, esc := range m.escrows {
		if !esc.resolved {
			rec.PendingCount++
		}
	}
	outcomes := m.deliveryOutcomes
	if window > 0 && len(outcomes) > window {
		outcomes = outcomes[len(outcomes)-window:]
	}
	distinctAskers := make(map[string]struct{})
	for _, d := range outcomes {
		if d.Asker == creator {
			// M1 fix: a self-deal never counts as third-party delivery,
			// good or bad — exclude entirely from Answered/Missed/
			// ResponseBlocks/DistinctAskers, but keep it visible via
			// SelfDealtExcluded so the exclusion itself is auditable rather
			// than a silent drop (see DeliveryHistory, which still returns
			// EVERY resolved ask including self-deals — this filtering is
			// scoped to the display-grade aggregate only).
			rec.SelfDealtExcluded++
			continue
		}
		distinctAskers[d.Asker] = struct{}{}
		if d.Answered {
			rec.AnsweredCount++
			rec.ResponseBlocks = append(rec.ResponseBlocks, d.ResponseBlocks)
		} else {
			rec.MissedCount++
		}
	}
	rec.DistinctAskers = len(distinctAskers)
	return rec
}

// EventHistory returns every raw event this Index has folded for creator,
// in ingestion (== on-chain emission) order — the audit surface (task spec
// item 3). Duplicate redeliveries (see Ingest's idempotency doc) never
// appear twice here, by construction — they were skipped before folding.
func (ix *Index) EventHistory(creator string) []RawEvent {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	m, ok := ix.markets[creator]
	if !ok {
		return nil
	}
	out := make([]RawEvent, len(m.history))
	copy(out, m.history)
	return out
}

// MarketSummary is a last-known-from-events snapshot — AUDIT/CROSS-CHECK
// ONLY. LastFace/LastCap/Closed here are this Index's own replay of the
// event log, not an authoritative chain read (SPEC-CREATOR-KEYS.md §2.5
// routes "status, supply, floor" through a direct getStateByKeys call,
// deliberately NOT through this indexer) — use this to cross-check a chain
// read against the event history, never as a substitute for one.
//
// Closed (M5 fix, 2026-07-21): this Index now clears Closed back to false on
// a `registered` event that follows a prior `closed` one — see
// foldKnownEventLocked's KindRegistered case for the full re-registration
// (new-incarnation) reset. Before this fix a returning creator showed as
// permanently CLOSED here, forever, regardless of what the chain actually
// said.
//
// CommissionBookedHbd/CommissionReturnedHbd (M4 fix, 2026-07-21) are this
// creator's LIFETIME totals (never reset by re-registration — see
// marketData's own doc on these two fields) — the per-market breakdown
// rolling up into Index.TreasuryHbd/Index.ReclaimOutflowHbd's package-wide
// totals. nil (like LastFace/LastCap) only when Known is false; a known
// creator that has never had an answer/reclaim yet reads as big.Int(0), not
// nil — there is no ambiguity to preserve here the way LastFace/LastCap's
// nil-vs-zero distinction exists for (a market can legitimately never have
// posted a face of exactly "0" on-chain — MinFace forbids it — but it can
// completely legitimately have zero lifetime commission activity).
type MarketSummary struct {
	Creator               string
	Known                 bool // false if this Index has never observed any event for creator
	LastFace              *big.Int
	LastCap               *big.Int
	Closed                bool
	CommissionBookedHbd   *big.Int
	CommissionReturnedHbd *big.Int
}

func (ix *Index) MarketSummary(creator string) MarketSummary {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	m, ok := ix.markets[creator]
	if !ok {
		return MarketSummary{Creator: creator}
	}
	s := MarketSummary{Creator: creator, Known: true, Closed: m.closed}
	if m.lastFace != nil {
		s.LastFace = new(big.Int).Set(m.lastFace)
	}
	if m.lastCap != nil {
		s.LastCap = new(big.Int).Set(m.lastCap)
	}
	s.CommissionBookedHbd = new(big.Int).Set(m.commissionBookedHbd)
	s.CommissionReturnedHbd = new(big.Int).Set(m.commissionReturnedHbd)
	return s
}

// TreasuryHbd returns this Index's replayed reconstruction of the
// contract's GLOBAL treasury balance (kTreasury(), keys.go:15 — "where
// commission + subscription land," a SINGLE key shared by every market, not
// scoped per creator) — the sum of every EvRegistered.feePaid,
// EvRenewed.paid, and EvAnswered.commissionHbd this Index has ever folded,
// across every creator (M4 fix, 2026-07-21: closes "the indexer can never
// serve as a solvency cross-check" — see PRUNED-ADJUDICATION-2026-07-21.md).
//
// AUDIT/CROSS-CHECK ONLY, same disclaimer as MarketSummary: SPEC-CREATOR-
// KEYS.md §2.5 routes the LIVE balance through a direct chain read; this is
// a REPLAY, not a substitute for one. It is also — by construction — a pure
// MONOTONIC sum: core has no debit path off kTreasury() today (that gap is
// C2 in the same adjudication, out of this package's scope to fix), so this
// total should track kTreasury()'s live value exactly for as long as that
// remains true, and will need a corresponding debit-event fold the day a
// withdrawTreasury-shaped entrypoint ships.
func (ix *Index) TreasuryHbd() *big.Int {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	return new(big.Int).Set(ix.treasuryHbd)
}

// ReclaimOutflowHbd returns this Index's replayed reconstruction of the
// TOTAL HBD commission ever handed back to an asker via Reclaim (I5: "no
// commission on refunds... we are paid for delivered service only") — the
// sum of every EvReclaimed.commissionHbd this Index has ever folded, across
// every creator (M4 fix, 2026-07-21). This money was HELD against an escrow
// (Ask) but never reached the treasury, because the creator never answered
// — it is the complementary outflow to TreasuryHbd's Answer-side inflow,
// and together the two let a full replay account for both directions a
// held commission can resolve. Also GLOBAL rather than per-market, for the
// same reason TreasuryHbd is (see its own doc) — on top of the per-creator
// breakdown MarketSummary.CommissionReturnedHbd carries.
func (ix *Index) ReclaimOutflowHbd() *big.Int {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	return new(big.Int).Set(ix.reclaimOutflowHbd)
}
