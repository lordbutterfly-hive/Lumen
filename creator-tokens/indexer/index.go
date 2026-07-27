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
// Ev* event shapes (plus a handful of contract-only ones — see events.go's
// own file doc), nothing more.
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
	Answered       bool   // true=answered (kept)
	Declined       bool   // creator said no inside the window — NOT a miss (core/delivery.go)
	ResponseBlocks uint64 // ResolvedBlock-AskedBlock; meaningful only when Answered
}

// marketData is one creator's folded state.
type marketData struct {
	creator string

	// lastFace/lastCap/closed/retired are a REPLAY of registered/faceChanged/
	// capChanged/closed/retired events — audit/cross-check only, never
	// authoritative (see file doc and MarketSummary's own doc).
	lastFace *big.Int
	lastCap  *big.Int
	closed   bool

	// retired mirrors a "retired" event (contract-only, ../contract/main.go's
	// `retire` entrypoint — see indexer/events.go's KindRetired doc). This is
	// DELIBERATELY a separate flag from `closed`, never folded into it: Retire
	// (core/market.go) forces the market straight to FROZEN — an irreversible
	// wind-down where Sell has already closed and Refund is the open exit —
	// while `closed` mirrors the market reaching the later, terminal CLOSED
	// state (core.CloseIfDrained, which additionally requires supply==0).
	// Conflating the two would tell a consumer a retiring-but-not-yet-drained
	// market (holders may still be owed a Refund) has ALREADY fully wound
	// down, which is false. Reset on re-registration exactly like `closed`
	// (see foldKnownEventLocked's KindRegistered case) — core itself resets
	// kRetiredAt to 0 on every Register call (market.go), so a returning
	// creator's new incarnation is never born already retired.
	retired bool

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

	// holderCreators/askerAsks (DESIGN + IMPLEMENTATION, 2026-07-28 — see the
	// handoff report for the full feasibility writeup) are the two GLOBAL
	// reverse indexes ../frontend's real data layer already calls TODAY with
	// no backing implementation anywhere:
	// features/creator-tokens/lib/vsc-data-source.ts's readWallet/readMyAsks
	// fetch `/holders/{holder}/positions` and `/askers/{asker}/asks` — this
	// package has no HTTP server (out of scope to build one here), but
	// neither did any INDEX QUERY exist to back such an endpoint with, which
	// is the actual gap this closes, mirroring how DeliveryRecord/
	// MarketSummary/TreasuryHbd already exist as query+DTO pairs with no HTTP
	// server built around them yet.
	//
	// Both are safe, honest OVER-approximations by design, matching the
	// frontend's own already-written consumption pattern exactly: readWallet
	// re-reads live chain state for every candidate creator this returns and
	// filters to `tokensHeld > 0` there; readMyAsks re-reads the live escrow
	// for every candidate (creator,seq) this returns. So a creator/ask this
	// holder/asker no longer has anything live to show for costs one wasted
	// read, never a wrong answer — the one failure mode that matters
	// (silently OMITTING a real position/ask) cannot happen as long as every
	// balance/escrow mutation in foldKnownEventLocked also updates its
	// matching reverse index (see noteHolderCreator's call sites).
	//
	// NEVER reset by a re-registration (see foldKnownEventLocked's
	// KindRegistered case, which resets m.balances/m.escrows but not
	// these) — a holder who held a prior, now-reset incarnation's tokens
	// still gets a live read that correctly comes back empty; dropping the
	// history here would risk the opposite, worse failure (an active
	// position missed because this Index guessed it was stale).
	holderCreators map[string]map[string]struct{} // holder -> set of creators ever touched
	askerAsks      map[string][]AskRef             // asker -> every (creator,seq) ever asked, in ask order

	stats Stats
}

// AskRef identifies one escrow by its (creator, seq) join key — the same pair
// core/ask.go's escrow map is keyed by. AskerAsks returns these so a caller
// (the wasm wrapper has no reverse asker->escrow index of its own — see
// AskerAsks' own doc) can resolve each one against a live chain read.
type AskRef struct {
	Creator string
	Seq     uint64
}

// NewIndex returns an empty Index ready for Ingest/Poll.
func NewIndex() *Index {
	return &Index{
		markets:           make(map[string]*marketData),
		seenKeys:          make(map[string]struct{}),
		treasuryHbd:       big.NewInt(0),
		reclaimOutflowHbd: big.NewInt(0),
		holderCreators:    make(map[string]map[string]struct{}),
		askerAsks:         make(map[string][]AskRef),
	}
}

// noteHolderCreator records that `holder` has had a balance-affecting event
// on `creator`'s market — called from every addBal/subBal call site in
// foldKnownEventLocked, never from marketData.addBal/subBal themselves
// (those are plain per-market helpers with no back-reference to the owning
// Index; duplicating the one-line call at each site is simpler and safer
// than threading a back-pointer through marketData for this alone). A blank
// holder is a no-op — no wire shape in this package's recognized events ever
// produces one for a field this is called with, but this guards against a
// hypothetical future caller the same way parseAmount guards against
// upstream corruption rather than assuming it away.
func (ix *Index) noteHolderCreator(holder, creator string) {
	if holder == "" {
		return
	}
	set, ok := ix.holderCreators[holder]
	if !ok {
		set = make(map[string]struct{})
		ix.holderCreators[holder] = set
	}
	set[creator] = struct{}{}
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
			m.retired = false // mirrors core's own kRetiredAt reset to 0 on Register (market.go)
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
		ix.noteHolderCreator(p.Actor, p.Creator)
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
		ix.noteHolderCreator(p.Actor, p.Creator)
		ix.noteHolderCreator(p.To, p.Creator)
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
		ix.noteHolderCreator(p.Actor, p.Creator)
		// AskerAsks (DESIGN + IMPLEMENTATION, 2026-07-28): (creator,seq) is a
		// permanently unique join key across every incarnation of this
		// market — core/market.go's own doc: kSeq is "DELIBERATELY MONOTONE
		// ACROSS INCARNATIONS," never reset by a re-registration — so
		// appending here, unconditionally and never cleared, cannot collide
		// with a later incarnation's own asks the way m.escrows (reset on
		// re-registration, a LOCAL per-market map) safely can.
		ix.askerAsks[p.Actor] = append(ix.askerAsks[p.Actor], AskRef{Creator: p.Creator, Seq: p.Seq})
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
		ix.noteHolderCreator(p.Creator, p.Creator)
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
		// p.Asker, NEVER p.Actor: Reclaim is permissionless, so Actor may be a
		// keeper or any stranger pushing an abandoned escrow, while the chain
		// always credits the escrow's own asker (core/ask.go Reclaim). Crediting
		// Actor mis-attributed every third-party reclaim — the balance mirror
		// silently diverged from chain state with no error anywhere.
		m.addBal(p.Asker, credits)
		ix.noteHolderCreator(p.Asker, p.Creator)
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

	case KindDeclined:
		// Same money as a reclaim (credits and the whole commission go back to
		// the asker), a DIFFERENT record: the creator answered promptly with
		// "no" inside the answer window instead of going silent, which the
		// contract counts as delivery, not as a miss (core/delivery.go). Folding
		// this as a reclaim would show a conscientious creator the same delivery
		// record as an absent one.
		p := ev.Declined
		credits, ok1 := parseAmount(p.Credits)
		commissionHbd, ok2 := parseAmount(p.CommissionHbd)
		if !ok1 || !ok2 {
			return false
		}
		m := ix.market(p.Creator)
		m.addBal(p.Asker, credits)
		ix.noteHolderCreator(p.Asker, p.Creator)
		m.commissionReturnedHbd = new(big.Int).Add(m.commissionReturnedHbd, commissionHbd)
		ix.reclaimOutflowHbd = new(big.Int).Add(ix.reclaimOutflowHbd, commissionHbd)
		if esc, known := m.escrows[p.Seq]; known && !esc.resolved {
			esc.resolved = true
			m.deliveryOutcomes = append(m.deliveryOutcomes, DeliveryOutcome{
				Seq: p.Seq, Asker: esc.asker, AskedBlock: esc.askedBlock,
				ResolvedBlock: p.Block, Answered: false, Declined: true,
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
		ix.noteHolderCreator(p.Actor, p.Creator)
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
		ix.noteHolderCreator(p.Holder, p.Creator)
		m.history = append(m.history, raw)

	case KindClosed:
		p := ev.Closed
		m := ix.market(p.Creator)
		m.closed = true // idempotent set — a duplicate "closed" (core.CloseIfDrained's own documented idempotent return) is a harmless repeat
		m.history = append(m.history, raw)

	case KindBought:
		// DEFECT FIX: KindBought/KindSold were entirely missing before this
		// fix — every buy and every sell fell through ParseEvent's default
		// Unknown path (Stats.Unknown++, nothing folded), so Position/
		// HolderList silently drifted from chain truth the moment the
		// bonding curve went live (Buy/Sell replaced the deleted PAR mint as
		// the ONLY issuance path). See indexer/events.go's KindBought doc.
		p := ev.Bought
		minted, ok1 := parseAmount(p.Minted)
		if !ok1 {
			return false
		}
		if _, ok := parseAmount(p.Cost); !ok { // audit-only — the curve leg into kReserve; live reserve is a direct chain read, never this package's job (file doc)
			return false
		}
		if _, ok := parseAmount(p.Fee); !ok { // audit-only — EvBought's wire shape carries only the COMBINED trade fee, never the FeeCreator/FeePlatform split BuyResult computes internally, so this Index cannot attribute any portion of it to the treasury or a creator's pull-claimable balance (see events.go's BoughtEvent doc and the handoff note)
			return false
		}
		if _, ok := parseAmount(p.TotalDue); !ok { // audit-only — Cost+Fee, the wrapper's single HiveDraw amount; never a credits/token amount
			return false
		}
		m := ix.market(p.Creator)
		// Buy mints straight into the buyer's OWN balance (buy.go:
		// "bal/wacq update via creditInflow") — the SAME kBal ledger
		// Ask/Transfer/Refund/Sell all share, so this is an ordinary addBal
		// against the existing balance map, not a new one.
		m.addBal(p.Actor, minted)
		ix.noteHolderCreator(p.Actor, p.Creator)
		m.history = append(m.history, raw)

	case KindSold:
		p := ev.Sold
		sold, ok1 := parseAmount(p.Sold)
		if !ok1 {
			return false
		}
		if _, ok := parseAmount(p.Gross); !ok { // audit-only — the curve leg debited from kReserve; not tracked, chain-read-only (same reasoning as Bought's Cost)
			return false
		}
		tax, okTax := parseAmount(p.Tax)
		if !okTax {
			return false
		}
		if _, ok := parseAmount(p.Fee); !ok { // audit-only — same combined-total limitation as Bought's Fee: no FeeCreator/FeePlatform split on the wire
			return false
		}
		if _, ok := parseAmount(p.Net); !ok { // audit-only — Net is the seller's HBD payout (sdk.HiveTransfer), NEVER a credits/token amount, so it is never folded into m.balances; mirrors RefundedEvent.Payout's identical audit-only treatment (index.go's KindRefunded case above)
			return false
		}
		m := ix.market(p.Creator)
		// The FULL slice leaves the seller's balance and the market's supply
		// on-chain (sell.go: "no burn, no withheld tokens") — the balance
		// debit is the TOKEN COUNT sold, never gross/net (those are HBD, not
		// credits/tokens).
		m.subBal(p.Actor, sold)
		ix.noteHolderCreator(p.Actor, p.Creator)
		// The exit tax is a real, UNSPLIT addMoney straight to the GLOBAL
		// kTreasury() (sell.go, RULING J/K: "one addMoney, no aggregate, no
		// distribution") — the SAME global key EvRegistered.feePaid/
		// EvRenewed.paid/EvAnswered.commissionHbd already fold into via
		// ix.treasuryHbd (see TreasuryHbd's own doc). Leaving this out would
		// make TreasuryHbd() silently under-count reality from the moment
		// Sell starts running — exactly the same class of silent drift this
		// whole fix exists to close. (Sell's Fee, unlike Tax, is NOT folded
		// here — see the audit-only check above for why: it is an unsplit
		// total and no portion of it is known to reach the treasury.)
		ix.treasuryHbd = new(big.Int).Add(ix.treasuryHbd, tax)
		m.history = append(m.history, raw)

	case KindRetired:
		// Contract-only event, not from core/events.go — see KindRetired's
		// own doc (indexer/events.go) and marketData.retired's own doc above
		// for why this is a SEPARATE flag from `closed`, never folded into
		// it.
		p := ev.Retired
		m := ix.market(p.Creator)
		m.retired = true
		m.history = append(m.history, raw)

	case KindOfferingCreated:
		// DEFECT FIX, 2026-07-28: this case, and the two Offering* cases below
		// it, did not exist at all. ParseEvent (events.go) has recognized and
		// correctly TYPED offeringCreated/offeringUpdated/offeringDeleted since
		// the offering catalogue shipped (2026-07-27) — ev.Unknown reads false
		// and ev.OfferingCreated/Updated/Deleted decode correctly — but with no
		// matching `case` here, execution fell straight through this switch to
		// the unconditional `return true` at its end. That is WORSE than
		// Stats.Unknown: ingestOneLocked reads a true return as "folded
		// successfully" and increments Stats.Ingested, so a real deployment's
		// own documented health check ("alert if Malformed/Unknown grows
		// unexpectedly," Stats' own doc) would see nothing wrong, while every
		// offering event silently did NOTHING — no ix.market() call, no
		// m.history append — so it could never appear in EventHistory (the
		// audit surface, task spec item 3) and no creator's market was even
		// created in this Index by an offering event alone. See the `default`
		// case at the end of this switch, added alongside this fix, for why
		// this exact class of gap cannot recur silently again.
		//
		// No money moves here (events.go's own doc: "an offering is a posted
		// price, and no HBD or token moves when one is created") — Price is
		// still validated (not merely appended raw) for the same reason every
		// other fold validates every documented money-shaped field, audit-only
		// or not (this function's own doc, and index_test.go's
		// TestIndex_MalformedAuditOnlyFieldRejectsWholeEvent) — a garbled Price
		// must not silently enter the audit log looking legitimate.
		p := ev.OfferingCreated
		if _, ok := parseAmount(p.Price); !ok {
			return false
		}
		m := ix.market(p.Creator)
		m.history = append(m.history, raw)

	case KindOfferingUpdated:
		// Same DEFECT FIX as KindOfferingCreated above — see that case's
		// comment. Covers both a reprice and a relabel (events.go's own doc);
		// either way both price fields are validated before this event is
		// allowed into the audit log.
		p := ev.OfferingUpdated
		if _, ok := parseAmount(p.OldPrice); !ok {
			return false
		}
		if _, ok := parseAmount(p.NewPrice); !ok {
			return false
		}
		m := ix.market(p.Creator)
		m.history = append(m.history, raw)

	case KindOfferingDeleted:
		// Same DEFECT FIX as KindOfferingCreated above. No money-shaped field
		// at all (events.go's OfferingDeletedEvent carries only creator/actor/
		// block/offeringId), so there is nothing to parseAmount here — this is
		// a pure history/audit entry, the same shape KindClosed already uses.
		p := ev.OfferingDeleted
		m := ix.market(p.Creator)
		m.history = append(m.history, raw)

	case KindTreasuryWithdrawn:
		// Contract-only event (events.go's KindTreasuryWithdrawn doc) — the
		// owner's withdrawal from the GLOBAL kTreasury() pot. Deliberately
		// NOT routed through ix.market(...): the wire carries no "creator" at
		// all (core.WithdrawTreasury is owner-gated and touches kTreasury()
		// alone, never any per-market key — core/read.go's own doc: "not a
		// per-market function at all"), so there is no single creator's
		// history this belongs in. This is the debit half TreasuryHbd's own
		// doc had already flagged as missing ("the pure MONOTONIC sum, no
		// debit path off kTreasury today claim ... is ALREADY STALE") — a
		// real owner withdrawal, unfolded, would leave TreasuryHbd() only
		// ever growing, silently overstating the live kTreasury() balance
		// forever after the first withdrawal.
		p := ev.TreasuryWithdrawn
		amount, ok := parseAmount(p.Amount)
		if !ok {
			return false
		}
		ix.treasuryHbd = new(big.Int).Sub(ix.treasuryHbd, amount)

	case KindTradeFeesClaimed:
		// Contract-only event (events.go's KindTradeFeesClaimed doc). Unlike
		// treasuryWithdrawn, THIS is per-creator — Actor doubles as the
		// creator identifier (kFeeBal is always keyed by the creator whose
		// market accrued the fee — core/tradefee.go's accrueTradeFee, called
		// only from buy.go/sell.go with `creator`, never any other account).
		// Audit-only: kFeeBal is a SEPARATE pull pot from kTreasury
		// (core/read.go's FeeBalanceOf: "neither reserve nor treasury"), so a
		// claim here must NEVER touch ix.treasuryHbd — doing so would double
		// count money that was never in the treasury to begin with. Not a
		// credits/token balance either (this is an HBD payout, mirroring
		// RefundedEvent.Payout's identical audit-only treatment), so it never
		// touches m.balances.
		p := ev.TradeFeesClaimed
		if _, ok := parseAmount(p.Amount); !ok {
			return false
		}
		m := ix.market(p.Actor)
		m.history = append(m.history, raw)

	default:
		// FAIL CLOSED (added alongside the Offering* fix above, 2026-07-28):
		// any Kind ParseEvent recognizes (Unknown==false) but that has no
		// explicit case above is now counted as Malformed rather than
		// silently returning true and doing nothing. Before this default
		// existed, exactly that silent-success gap is what let
		// offeringCreated/offeringUpdated/offeringDeleted ship recognized by
		// ParseEvent yet completely unfolded here for a full day, inflating
		// Stats.Ingested while never touching any market or history — the
		// one health signal (Stats.Malformed/Unknown) a real deployment is
		// told to alert on never fired. Every Kind ParseEvent can currently
		// produce with Unknown==false has an explicit case above; reaching
		// this default means a NEW kind was added to events.go's switch
		// without a matching fold here, and that must be loud, not silent.
		return false
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
	DeclinedCount     int      // creator said no inside the answer window and refunded in full — delivery, not a miss (core/delivery.go)
	PendingCount      int      // asked but neither answered nor reclaimed yet — a live gauge, NOT windowed (see doc below), NOT self-deal-filtered (see DeliveryRecord's own method doc)
	ResponseBlocks    []uint64 // one per ANSWERED, non-self-dealt ask in the window, in resolution order; never one for a reclaim (there is no "response time" for an ask nobody answered)
	DistinctAskers    int      // count of distinct non-self-dealt askers contributing to AnsweredCount+MissedCount in this window (M1 fix)
	SelfDealtExcluded int      // count of resolved asks in this window where Asker==Creator, excluded from every field above (M1 fix) — kept visible/auditable rather than silently dropped
}

// DeliveryRecord summarizes DeliveryHistory over the most recent `window`
// resolved asks. AnsweredCount+MissedCount+DeclinedCount+SelfDealtExcluded
// always sums to
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
		switch {
		case d.Answered:
			rec.AnsweredCount++
			rec.ResponseBlocks = append(rec.ResponseBlocks, d.ResponseBlocks)
		case d.Declined:
			// Its own bucket, counted as neither delivered-with-an-answer nor
			// missed: the contract treats a decline as running your shop
			// properly (core/delivery.go recordDelivery), and it carries no
			// response TIME worth averaging into the answered stats.
			rec.DeclinedCount++
		default:
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
//
// Retired (DEFECT FIX, 2026-07-28) mirrors a "retired" event — see
// marketData.retired's own doc for why this is DELIBERATELY separate from
// Closed: Retire forces an irreversible FROZEN wind-down (Sell already
// closed, Refund the open exit) which is NOT the same fact as Closed (the
// later, terminal state that additionally requires supply==0). Before this
// fix `retired` was not recognized at all (Stats.Unknown), so this field did
// not exist and a retiring market was indistinguishable from a healthy one
// until it eventually also fully drained.
type MarketSummary struct {
	Creator               string
	Known                 bool // false if this Index has never observed any event for creator
	LastFace              *big.Int
	LastCap               *big.Int
	Closed                bool
	Retired               bool
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
	s := MarketSummary{Creator: creator, Known: true, Closed: m.closed, Retired: m.retired}
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
// EvRenewed.paid, EvAnswered.commissionHbd, and (DEFECT FIX, 2026-07-28)
// EvSold.Tax this Index has ever folded, across every creator (M4 fix,
// 2026-07-21: closes "the indexer can never serve as a solvency cross-check"
// — see PRUNED-ADJUDICATION-2026-07-21.md). EvSold.Tax is included because
// sell.go's exit tax is a real, UNSPLIT addMoney to this same kTreasury() key
// (RULING J/K) — omitting it once Sell started trading would have made this
// total silently under-count reality forever, the identical bug class the
// rest of this fix closes for balances. EvBought/EvSold's Fee fields are
// deliberately NOT folded here: both wire shapes carry only the COMBINED
// trade fee (no FeeCreator/FeePlatform split), so no portion of either is
// attributable to the treasury from the event alone.
//
// AUDIT/CROSS-CHECK ONLY, same disclaimer as MarketSummary: SPEC-CREATOR-
// KEYS.md §2.5 routes the LIVE balance through a direct chain read; this is
// a REPLAY, not a substitute for one. NOTE (found while fixing the above,
// out of this fix's scope): the "pure MONOTONIC sum, no debit path off
// kTreasury today" claim this doc used to make is ALREADY STALE —
// ../contract/main.go's `withdrawTreasury` entrypoint is live and hand-logs
// its own `{"ev":"treasuryWithdrawn",...}` line (main.go, WithdrawTreasury),
// which this package does not recognize either (falls into Stats.Unknown,
// same as `retired` did before this fix, and same as `tradeFeesClaimed`,
// ClaimTradeFees's own hand-built log). Neither is one of the two defects
// this change was scoped to fix; flagged here and in the handoff report for
// whoever picks up the treasury-debit side next, rather than silently left
// for a future reader to rediscover as "surely this is still monotonic."
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

// ---------------------------------------------------------------------------
// Reverse-index query surface (DESIGN + IMPLEMENTATION, 2026-07-28)
//
// ../frontend's real data layer (features/creator-tokens/lib/vsc-data-
// source.ts) already calls `/holders/{holder}/positions` and
// `/askers/{asker}/asks` today — endpoints this package never had any query
// to back, on a package that has no HTTP server at all. HolderCreators and
// AskerAsks below are that missing query surface — the two methods a future
// HTTP layer would wrap one-to-one into those two endpoints, exactly the same
// gap between "query exists here" and "HTTP server exists somewhere else"
// every other query in this file already has (DeliveryRecord/MarketSummary/
// TreasuryHbd all predate any server too).
//
// FEASIBILITY, verified against the actual frontend call sites (not
// invented): vsc-data-source.ts's readWallet only needs each result object to
// carry a `creator` field (it extracts that and re-reads full position data
// live: "const creators = positions.map(p => getJsonProp(p,'creator'))...");
// readMyAsks only needs `{creator, seq}` pairs (same live-reread pattern:
// "state[kEscrow(p.creator, p.seq)]"). Neither caller needs this package to
// serve a computed balance or escrow status over the wire — both already
// treat this index as a pure "where should I even look" hint and re-verify
// against the chain themselves. That is exactly the shape this fold can
// support: every balance/escrow mutation already flows through one of a
// small, enumerable set of call sites (see noteHolderCreator's doc and the
// askerAsks append in the KindAsked case), so maintaining both reverse
// indexes incrementally, in the same pass, is a few one-line additions, not
// a new subsystem.
// ---------------------------------------------------------------------------

// HolderCreators returns every creator whose market `holder` has EVER had a
// balance-affecting event on (prepaid/transferred/asked/answered/reclaimed/
// declined/refunded/refundPushed/bought/sold — see noteHolderCreator's call
// sites for the exhaustive list), sorted for determinism. This is
// intentionally an OVER-approximation, not a live "currently holds tokens"
// answer (Position/HolderList already serve that, scoped to one creator at a
// time) — see the file-level doc above for why an over-inclusive candidate
// list is safe here (the caller re-reads live state and filters) while an
// under-inclusive one would not be.
func (ix *Index) HolderCreators(holder string) []string {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	set, ok := ix.holderCreators[holder]
	if !ok {
		return nil
	}
	out := make([]string, 0, len(set))
	for c := range set {
		out = append(out, c)
	}
	sort.Strings(out)
	return out
}

// AskerAsks returns every (creator,seq) `asker` has EVER asked, oldest first
// — every resolved AND still-pending ask alike (mirrors readMyAsks' own
// "re-read the live escrow to learn its current status" pattern; this
// package does not pre-filter by status here any more than HolderCreators
// pre-filters by current balance). nil if `asker` has never asked anything
// this Index has observed.
func (ix *Index) AskerAsks(asker string) []AskRef {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	refs := ix.askerAsks[asker]
	if refs == nil {
		return nil
	}
	out := make([]AskRef, len(refs))
	copy(out, refs)
	return out
}
