package indexer

import "strconv"

// api.go — JSON-shaped DTOs, deliberately kept separate from the internal
// query surface (index.go) so a future HTTP layer (not built here — out of
// this change's scope; mirrors hive-price-market/indexer/http.go's role
// when this package is wired to a real endpoint) has ready-made response
// shapes with money already rendered as base-10 strings, never a JSON
// number (a JS `number` loses precision above 2^53 — see events.go's
// identical rule for the wire format this package consumes).

// PositionView is api.go's wire shape for Position (task spec item 2:
// "per-holder positions").
type PositionView struct {
	Creator string `json:"creator"`
	Holder  string `json:"holder"`
	Credits string `json:"credits"`
}

func (ix *Index) PositionView(creator, holder string) PositionView {
	return PositionView{
		Creator: creator,
		Holder:  holder,
		Credits: ix.Position(creator, holder).String(),
	}
}

// HolderListView is api.go's wire shape for HolderList (task spec item 2:
// "per-creator holder lists" — the fund-path keeper query).
type HolderListView struct {
	Creator string   `json:"creator"`
	Holders []string `json:"holders"`
}

func (ix *Index) HolderListView(creator string) HolderListView {
	holders := ix.HolderList(creator)
	if holders == nil {
		holders = []string{}
	}
	return HolderListView{Creator: creator, Holders: holders}
}

// DeliveryRecordView is api.go's wire shape for DeliveryRecord (task spec
// item 1). ResponseBlocks is rendered as decimal strings for consistency
// with every other number in this API that could in principle grow large,
// even though a block-count delta realistically never approaches the 2^53
// float boundary — uniformity costs nothing and means a frontend never has
// to remember which numeric fields are "safe" ints and which aren't.
//
// DistinctAskers/SelfDealtExcluded (M1 fix, 2026-07-21) mirror
// DeliveryRecord's own fields exactly — see that struct's doc for the full
// self-deal-exclusion rationale. Surfacing both here is the whole point of
// the fix: a frontend showing AnsweredCount/MissedCount without also
// showing DistinctAskers (so it can down-weight a thin record) or
// SelfDealtExcluded (so the exclusion itself is visible/auditable, not a
// silent drop) reintroduces exactly the opacity M1 closes.
//
// DeclinedCount (DEFECT FIX, 2026-07-28) mirrors DeliveryRecord.DeclinedCount
// exactly — it was computed correctly by index.go's fold all along (a
// prompt, full-refund "no" is explicitly NOT a miss, core/delivery.go) but
// this DTO dropped it on the floor, so no consumer of this wire shape could
// ever see the distinction the contract's own delivery gate depends on: a
// creator who declines fast looked byte-for-byte identical here to one who
// never responds at all, both invisible inside a MissedCount that never
// counted either of them (declines were never in MissedCount — they were
// just nowhere). Add this to any FUTURE wire projection of DeliveryRecord
// too, for the same reason.
type DeliveryRecordView struct {
	Creator           string   `json:"creator"`
	AnsweredCount     int      `json:"answeredCount"`
	MissedCount       int      `json:"missedCount"`
	DeclinedCount     int      `json:"declinedCount"`
	PendingCount      int      `json:"pendingCount"`
	ResponseBlocks    []string `json:"responseBlocks"`
	DistinctAskers    int      `json:"distinctAskers"`
	SelfDealtExcluded int      `json:"selfDealtExcluded"`
}

func (ix *Index) DeliveryRecordView(creator string, window int) DeliveryRecordView {
	rec := ix.DeliveryRecord(creator, window)
	rb := make([]string, len(rec.ResponseBlocks))
	for i, v := range rec.ResponseBlocks {
		rb[i] = strconv.FormatUint(v, 10)
	}
	return DeliveryRecordView{
		Creator:           rec.Creator,
		AnsweredCount:     rec.AnsweredCount,
		MissedCount:       rec.MissedCount,
		DeclinedCount:     rec.DeclinedCount,
		PendingCount:      rec.PendingCount,
		ResponseBlocks:    rb,
		DistinctAskers:    rec.DistinctAskers,
		SelfDealtExcluded: rec.SelfDealtExcluded,
	}
}

// EventHistoryView is api.go's wire shape for EventHistory (task spec item
// 3: "a per-market event history for audit"). Events is the raw folded log,
// each entry's Data already the exact JSON string core/events.go produced —
// deliberately NOT re-typed/re-shaped per event kind here, so this endpoint
// never falls out of sync with core/events.go's schema and needs no update
// when a thirteenth event is ever added.
type EventHistoryView struct {
	Creator string     `json:"creator"`
	Events  []RawEvent `json:"events"`
}

func (ix *Index) EventHistoryView(creator string) EventHistoryView {
	events := ix.EventHistory(creator)
	if events == nil {
		events = []RawEvent{}
	}
	return EventHistoryView{Creator: creator, Events: events}
}

// MarketSummaryView is api.go's wire shape for MarketSummary — AUDIT/
// CROSS-CHECK ONLY, see MarketSummary's own doc in index.go. LastFace/
// LastCap are omitted (not "0") when never observed, so a frontend can
// distinguish "this market's registered event was never seen by this
// Index" from "the creator posted 0," which core.MinFace/MinCap make
// impossible on-chain anyway but this package should not assume that of
// its own replay. CommissionBookedHbd/CommissionReturnedHbd (M4 fix,
// 2026-07-21) get the same omitempty-when-unknown treatment, but a KNOWN
// creator with zero lifetime commission activity renders "0" (never
// omitted) — see MarketSummary's own doc for why that case has no
// ambiguity to preserve, unlike LastFace/LastCap.
//
// Retired (DEFECT FIX, 2026-07-28) mirrors MarketSummary.Retired — see that
// field's own doc, and marketData.retired's, for why it is a separate
// boolean from Closed, never folded into it: retiring (irreversible FROZEN,
// Sell closed, Refund open) is not the same fact as closed (terminal,
// supply==0). No omitempty: like Closed, false is a real, meaningful answer
// for a known creator, not an absence.
type MarketSummaryView struct {
	Creator               string `json:"creator"`
	Known                 bool   `json:"known"`
	LastFace              string `json:"lastFace,omitempty"`
	LastCap               string `json:"lastCap,omitempty"`
	Closed                bool   `json:"closed"`
	Retired               bool   `json:"retired"`
	CommissionBookedHbd   string `json:"commissionBookedHbd,omitempty"`
	CommissionReturnedHbd string `json:"commissionReturnedHbd,omitempty"`
}

func (ix *Index) MarketSummaryView(creator string) MarketSummaryView {
	s := ix.MarketSummary(creator)
	v := MarketSummaryView{Creator: s.Creator, Known: s.Known, Closed: s.Closed, Retired: s.Retired}
	if s.LastFace != nil {
		v.LastFace = s.LastFace.String()
	}
	if s.LastCap != nil {
		v.LastCap = s.LastCap.String()
	}
	if s.CommissionBookedHbd != nil {
		v.CommissionBookedHbd = s.CommissionBookedHbd.String()
	}
	if s.CommissionReturnedHbd != nil {
		v.CommissionReturnedHbd = s.CommissionReturnedHbd.String()
	}
	return v
}

// TreasurySummaryView is api.go's wire shape for the M4 solvency
// cross-check totals (Index.TreasuryHbd / Index.ReclaimOutflowHbd) — GLOBAL
// across every creator market this Index has observed, matching
// kTreasury()'s own single-global-key shape (keys.go:15). AUDIT/CROSS-CHECK
// ONLY, same disclaimer as MarketSummaryView — never a substitute for a
// direct chain read of kTreasury() itself.
type TreasurySummaryView struct {
	TreasuryHbd       string `json:"treasuryHbd"`
	ReclaimOutflowHbd string `json:"reclaimOutflowHbd"`
}

func (ix *Index) TreasurySummaryView() TreasurySummaryView {
	return TreasurySummaryView{
		TreasuryHbd:       ix.TreasuryHbd().String(),
		ReclaimOutflowHbd: ix.ReclaimOutflowHbd().String(),
	}
}

// HolderPositionRef is one candidate creator a future `/holders/{holder}/
// positions` endpoint would return — see Index.HolderCreators' own doc for
// the exact shape this was reverse-engineered against:
// ../frontend/apps/blog/features/creator-tokens/lib/vsc-data-source.ts's
// readWallet only ever reads `.creator` off each element
// ("positions.map(p => getJsonProp(p,'creator'))") before re-reading full
// position data live — so `creator` is the ONLY field that wire consumer
// needs, and the minimal correct shape is exactly this, nothing more.
type HolderPositionRef struct {
	Creator string `json:"creator"`
}

// HolderPositionsView is api.go's wire shape for Index.HolderCreators — the
// candidate list backing a future `/holders/{holder}/positions` endpoint
// (task spec: "what consumers need and cannot get"). Positions is never nil
// (matches HolderListView/EventHistoryView's own "empty slice, not null"
// convention).
type HolderPositionsView struct {
	Holder    string              `json:"holder"`
	Positions []HolderPositionRef `json:"positions"`
}

func (ix *Index) HolderPositionsView(holder string) HolderPositionsView {
	creators := ix.HolderCreators(holder)
	positions := make([]HolderPositionRef, len(creators))
	for i, c := range creators {
		positions[i] = HolderPositionRef{Creator: c}
	}
	return HolderPositionsView{Holder: holder, Positions: positions}
}

// AskRefView is one candidate (creator,seq) escrow reference a future
// `/askers/{asker}/asks` endpoint would return — matching vsc-data-source.ts's
// readMyAsks exactly: it reads `.creator` (string) and `.seq` (a bare JS
// `number`, checked via `typeof p.seq === 'number'` — Seq stays an unquoted
// uint64 here for exactly that reason, the same bare-number convention every
// other seq/block/count field in this package's events already uses) before
// re-reading the live escrow itself.
type AskRefView struct {
	Creator string `json:"creator"`
	Seq     uint64 `json:"seq"`
}

// AskerAsksView is api.go's wire shape for Index.AskerAsks — the candidate
// list backing a future `/askers/{asker}/asks` endpoint. Asks is never nil.
type AskerAsksView struct {
	Asker string       `json:"asker"`
	Asks  []AskRefView `json:"asks"`
}

func (ix *Index) AskerAsksView(asker string) AskerAsksView {
	refs := ix.AskerAsks(asker)
	asks := make([]AskRefView, len(refs))
	for i, r := range refs {
		asks[i] = AskRefView{Creator: r.Creator, Seq: r.Seq}
	}
	return AskerAsksView{Asker: asker, Asks: asks}
}
