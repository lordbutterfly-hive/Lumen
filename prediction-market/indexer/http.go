package indexer

import (
	"encoding/json"
	"net/http"
	"strconv"
)

// NewHTTPHandler exposes Index's query surface as a small, GET-only JSON
// API — the shape a future VscMarketDataSource (or a standalone indexer
// service sitting in front of it) would call for the pieces the contract
// itself cannot answer. Stdlib only: Go 1.22's http.ServeMux method+wildcard
// patterns (e.g. "GET /rounds/{id}/bettors") are enough; no router
// dependency needed.
//
// Routes:
//
//	GET /rounds/{id}/bettors      -> RoundBettorsView
//	GET /rounds/{id}/summary      -> RoundSummary (as JSON)
//	GET /positions/{acct}         -> []PositionSummary for that account, as JSON
//	GET /positions/{acct}/unclaimed -> UnclaimedView
//	GET /house/{asset}            -> HouseTakenView
//
// {id} must parse as a uint64; {acct}/{asset} are taken as-is (URL path
// escaping is ServeMux's job, not this handler's).
func NewHTTPHandler(ix *Index) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /rounds/{id}/bettors", func(w http.ResponseWriter, r *http.Request) {
		id, ok := parseRoundID(w, r)
		if !ok {
			return
		}
		view, ok := ix.RoundBettorsView(id)
		if !ok {
			writeJSONError(w, http.StatusNotFound, "round not found")
			return
		}
		writeJSON(w, http.StatusOK, view)
	})

	mux.HandleFunc("GET /rounds/{id}/summary", func(w http.ResponseWriter, r *http.Request) {
		id, ok := parseRoundID(w, r)
		if !ok {
			return
		}
		summary, ok := ix.RoundSummary(id)
		if !ok {
			writeJSONError(w, http.StatusNotFound, "round not found")
			return
		}
		writeJSON(w, http.StatusOK, roundSummaryJSON{
			RoundID:     idString(summary.RoundID),
			Creator:     summary.Creator,
			Resolved:    summary.Resolved,
			State:       summary.State,
			Winner:      summary.Winner,
			WinnerValid: summary.WinnerValid,
			VoidReason:  summary.VoidReason,
			Bettors:     summary.Bettors,
			TotalBets:   summary.TotalBets.String(),
		})
	})

	mux.HandleFunc("GET /positions/{acct}", func(w http.ResponseWriter, r *http.Request) {
		acct := r.PathValue("acct")
		positions := ix.MyPositions(acct)
		out := make([]positionJSON, len(positions))
		for i, p := range positions {
			out[i] = positionJSON{
				RoundID:       idString(p.RoundID),
				TotalStaked:   p.TotalStaked.String(),
				RoundResolved: p.RoundResolved,
				RoundState:    p.RoundState,
				Claimed:       p.Claimed,
			}
			if p.Claimed {
				out[i].ClaimPayout = p.ClaimPayout.String()
				out[i].ClaimAsset = p.ClaimAsset
			}
		}
		writeJSON(w, http.StatusOK, out)
	})

	mux.HandleFunc("GET /positions/{acct}/unclaimed", func(w http.ResponseWriter, r *http.Request) {
		acct := r.PathValue("acct")
		writeJSON(w, http.StatusOK, ix.UnclaimedView(acct))
	})

	mux.HandleFunc("GET /house/{asset}", func(w http.ResponseWriter, r *http.Request) {
		asset := r.PathValue("asset")
		writeJSON(w, http.StatusOK, ix.HouseTakenView(asset))
	})

	return mux
}

type roundSummaryJSON struct {
	RoundID     string `json:"roundId"`
	Creator     string `json:"creator"`
	Resolved    bool   `json:"resolved"`
	State       string `json:"state"`
	Winner      int    `json:"winner"`
	WinnerValid bool   `json:"winnerValid"`
	VoidReason  string `json:"voidReason,omitempty"`
	Bettors     int    `json:"bettors"`
	TotalBets   string `json:"totalBets"`
}

type positionJSON struct {
	RoundID       string `json:"roundId"`
	TotalStaked   string `json:"totalStaked"`
	RoundResolved bool   `json:"roundResolved"`
	RoundState    string `json:"roundState"`
	Claimed       bool   `json:"claimed"`
	ClaimPayout   string `json:"claimPayout,omitempty"`
	ClaimAsset    string `json:"claimAsset,omitempty"`
}

func parseRoundID(w http.ResponseWriter, r *http.Request) (uint64, bool) {
	id, err := strconv.ParseUint(r.PathValue("id"), 10, 64)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid round id")
		return 0, false
	}
	return id, true
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeJSONError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
