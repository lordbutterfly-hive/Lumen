package indexer

import "strconv"

// BucketIDs is the fixed 5-bucket %-move convention this specific weekly
// market uses (hive-blog-rebuild/apps/blog/features/prediction-market/
// lib/bucket-defs.ts:14-20 — down_20/down_10/flat/up_10/up_20). It is a
// FRONTEND/product convention, not a contract fact: ../market/round.go's
// core is generic over N outcomes (any strikes slice), so this package's
// core Index deliberately keys everything by the raw integer outcome index
// the contract emits (matches BetEvent.Outcome). This slice is provided only
// so an API layer that KNOWS this deployment uses the 5-bucket convention
// can translate outcome index -> the same bucket id string the frontend's
// BUCKET_DEFS uses, without the core aggregator needing to know about it.
var BucketIDs = []string{"down_20", "down_10", "flat", "up_10", "up_20"}

// BucketID maps a contract outcome index to this deployment's bucket id
// string via BucketIDs, or "" if out of range (a round with a different N
// than 5 — the core is generic, so this can legitimately happen; callers
// building the DTOs below should fall back to the raw index as a string in
// that case, see RoundBettorsView/MyPositionView).
func BucketID(outcome int) string {
	if outcome < 0 || outcome >= len(BucketIDs) {
		return ""
	}
	return BucketIDs[outcome]
}

// RoundBettorsView is the single field this package exists to compute that
// types.ts's RoundState cannot get anywhere else: RoundState.bettors. A real
// VscMarketDataSource.readRound() merges this int into the rest of
// RoundState (asset/buckets/referencePrice/closesAt/... — all of which come
// from a getStateByKeys read instead, see DUMB-QUESTIONS E2; this package
// never fabricates those fields).
type RoundBettorsView struct {
	RoundID string `json:"roundId"`
	Bettors int    `json:"bettors"`
}

// RoundBettorsView builds the DTO for one round. ok=false if unknown.
func (ix *Index) RoundBettorsView(roundID uint64) (RoundBettorsView, bool) {
	s, ok := ix.RoundSummary(roundID)
	if !ok {
		return RoundBettorsView{}, false
	}
	return RoundBettorsView{RoundID: idString(roundID), Bettors: s.Bettors}, true
}

// MyPositionView mirrors types.ts's MyPosition field-for-field:
//
//	export interface MyPosition {
//	  roundId: string;
//	  stakeByBucket: Record<string, number>;
//	  totalStaked: number;
//	  claimed: boolean;
//	  claimable: boolean;
//	  payout?: number;
//	}
//
// Money fields (stakeByBucket's values, totalStaked, payout) are decimal
// base-unit STRINGS here, not JSON numbers/TS `number` — deliberately: this
// package only ever holds *big.Int amounts (see events.go's Amount/Payout
// doc), and a JS `number` loses precision above 2^53. Converting to the
// frontend's float display units (divide by 10^3, see ../market/params.go's
// MinBet="1000" convention) is a UI-layer decision this package does not
// make for you — do that conversion in VscMarketDataSource, once, at the
// edge, not here.
type MyPositionView struct {
	RoundID       string            `json:"roundId"`
	StakeByBucket map[string]string `json:"stakeByBucket"`
	TotalStaked   string            `json:"totalStaked"`
	Claimed       bool              `json:"claimed"`
	Claimable     bool              `json:"claimable"`
	Payout        *string           `json:"payout,omitempty"`
}

// MyPositionView builds the DTO for one (roundID, acct). ok=false if `acct`
// has no recorded bet in that round (mirrors readMyPosition's `| null`
// return in market-data-source.ts).
func (ix *Index) MyPositionView(roundID uint64, acct string) (MyPositionView, bool) {
	ix.mu.RLock()
	r, ok := ix.rounds[roundID]
	if !ok {
		ix.mu.RUnlock()
		return MyPositionView{}, false
	}
	if _, bet := ix.acctRounds[acct][roundID]; !bet {
		ix.mu.RUnlock()
		return MyPositionView{}, false
	}
	ps := ix.positionSummaryLocked(r, acct)
	ix.mu.RUnlock()

	stakeByBucket := make(map[string]string, len(ps.StakeByOutcome))
	for outcome, amt := range ps.StakeByOutcome {
		key := BucketID(outcome)
		if key == "" {
			key = idString(uint64(outcome)) // fallback for a non-5-outcome round
		}
		stakeByBucket[key] = amt.String()
	}

	view := MyPositionView{
		RoundID:       idString(roundID),
		StakeByBucket: stakeByBucket,
		TotalStaked:   ps.TotalStaked.String(),
		Claimed:       ps.Claimed,
		// Claimable exactly matches this package's MyUnclaimed definition
		// (bet-set minus claim-set on a resolved round) rather than
		// recomputing separately, so the two can never disagree.
		Claimable: ps.RoundResolved && !ps.Claimed && ps.TotalStaked.Sign() > 0,
	}
	if ps.Claimed {
		payout := ps.ClaimPayout.String()
		view.Payout = &payout
	}
	return view, true
}

// HouseTakenView is a small convenience wrapper for a JSON house-take
// response — not a types.ts type (the frontend has no house-take UI today),
// but kept in the same DTO style for a uniform API surface (http.go).
type HouseTakenView struct {
	Asset  string `json:"asset"`
	Amount string `json:"amount"`
}

func (ix *Index) HouseTakenView(asset string) HouseTakenView {
	return HouseTakenView{Asset: asset, Amount: ix.HouseTaken(asset).String()}
}

// UnclaimedView lists the resolved-but-unclaimed round ids for an account —
// the D7/"your claims history" surface (task spec item 3).
type UnclaimedView struct {
	Acct     string   `json:"acct"`
	RoundIDs []string `json:"roundIds"`
}

func (ix *Index) UnclaimedView(acct string) UnclaimedView {
	ids := ix.MyUnclaimed(acct)
	out := make([]string, len(ids))
	for i, id := range ids {
		out[i] = idString(id)
	}
	return UnclaimedView{Acct: acct, RoundIDs: out}
}

func idString(id uint64) string { return strconv.FormatUint(id, 10) }
