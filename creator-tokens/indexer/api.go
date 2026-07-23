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
type DeliveryRecordView struct {
	Creator           string   `json:"creator"`
	AnsweredCount     int      `json:"answeredCount"`
	MissedCount       int      `json:"missedCount"`
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
type MarketSummaryView struct {
	Creator               string `json:"creator"`
	Known                 bool   `json:"known"`
	LastFace              string `json:"lastFace,omitempty"`
	LastCap               string `json:"lastCap,omitempty"`
	Closed                bool   `json:"closed"`
	CommissionBookedHbd   string `json:"commissionBookedHbd,omitempty"`
	CommissionReturnedHbd string `json:"commissionReturnedHbd,omitempty"`
}

func (ix *Index) MarketSummaryView(creator string) MarketSummaryView {
	s := ix.MarketSummary(creator)
	v := MarketSummaryView{Creator: s.Creator, Known: s.Known, Closed: s.Closed}
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
