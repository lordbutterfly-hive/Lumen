package market

// CreateParams are the inputs to CreateRound (parsed from the action payload by
// the wasm layer). N outcomes are defined by N-1 strictly-increasing strike
// boundaries (bps of the HBD/HIVE feed); outcome k covers [strike[k-1], strike[k]).
type CreateParams struct {
	Asset       string
	Strikes     []uint64
	LockBlock   uint64
	SettleBlock uint64
	GraceBlocks uint64
	Label       string // human market description shown to users (on-chain)
	Creator     string // analyst/creator this round is attributed to (Creator Keys #7); defaults to the caller
	// ReferencePrice is the oracle price (same bps unit as the strikes / the
	// HBD/HIVE feed) at round creation that the strikes were set against — the
	// "%-move" reference. Recorded on-chain so a bettor/auditor can verify the
	// bucket boundaries were fair relative to the open price, instead of trusting
	// the free-text Label. The contract does not (and cannot, having no oracle
	// read at create time) validate strikes against it — it is transparency, not
	// enforcement. 0 = not supplied.
	ReferencePrice uint64
}

// CreateRound opens a new round from fully-validated params. It is called by the
// PERMISSIONLESS RollRound (which derives every param deterministically from the
// oracle), so there is no privileged creator and no gate here — the validation
// below is the only guard. It snapshots the current fee (0 on the zero-rake
// deploy) into the round (F-1). Returns the new round id.
func CreateRound(s Store, caller string, block uint64, p CreateParams) (uint64, error) {
	if !isNativeAsset(p.Asset) {
		return 0, newErr(ErrInput, "asset must be native hive or hbd")
	}
	n := len(p.Strikes) + 1
	if n < 2 || n > MaxOutcomes {
		return 0, newErr(ErrInput, "outcomes out of range [2, MaxOutcomes]")
	}
	for i, sb := range p.Strikes {
		if sb == 0 {
			return 0, newErr(ErrInput, "strike must be > 0")
		}
		if i > 0 && sb <= p.Strikes[i-1] {
			return 0, newErr(ErrInput, "strikes must be strictly increasing")
		}
	}
	if p.LockBlock <= block {
		return 0, newErr(ErrInput, "lock block must be in the future")
	}
	// Upper-bound lock/settle so a round can never be scheduled so far out that it
	// can NEVER settle or void → funds locked forever (NEW-1), and so no timing
	// sum can approach 2^64 (defense-in-depth vs the grace overflow C2). Bounding
	// LockBlock first also makes the LockBlock+MinSettleGapBlocks sum below safe.
	if p.LockBlock > block+MaxRoundHorizonBlocks {
		return 0, newErr(ErrInput, "lock block too far in the future")
	}
	if p.SettleBlock <= p.LockBlock {
		return 0, newErr(ErrInput, "settle block must be after lock block")
	}
	if p.SettleBlock > block+MaxRoundHorizonBlocks {
		return 0, newErr(ErrInput, "settle block too far in the future")
	}
	if p.SettleBlock < p.LockBlock+MinSettleGapBlocks {
		return 0, newErr(ErrInput, "settle must be >= MinSettleGapBlocks after lock")
	}
	// Cap grace so settleBlock+SettleWindowBlocks+grace cannot overflow uint64
	// and grace cannot be weaponized into an early/never VoidStale (C2).
	if p.GraceBlocks > MaxGraceBlocks {
		return 0, newErr(ErrInput, "grace blocks exceeds MaxGraceBlocks")
	}
	if len(p.Label) > MaxLabelLen {
		return 0, newErr(ErrInput, "label too long")
	}
	// One OPEN round per asset (round lifecycle). Reject a new round while the
	// previous round for this asset is still OPEN, so consecutive weekly betting
	// windows can never overlap and split liquidity, and a keeper/owner can't
	// accidentally double-open. The pointer stores id+1 (0 = none). This makes
	// "don't start a new round before the last one resolves" a structural
	// guarantee instead of an operator discipline. A mandatory TIME GAP between
	// rounds is deliberately NOT enforced here — that is off-chain scheduling
	// policy, not a fund-safety invariant.
	if prev := getU64(s, kActiveRound(p.Asset)); prev != 0 {
		if roundState(s, prev-1) == StateOpen {
			return 0, newErr(ErrState, "an open round already exists for this asset")
		}
	}

	id := getU64(s, kRoundCount())
	setU64(s, kRoundCount(), id+1)

	setStr(s, rk(id, "state"), StateOpen)
	setStr(s, rk(id, "asset"), p.Asset)
	setU64(s, rk(id, "n"), uint64(n))
	setStr(s, rk(id, "strikes"), joinU64(p.Strikes))
	setU64(s, rk(id, "lock"), p.LockBlock)
	setU64(s, rk(id, "settle"), p.SettleBlock)
	setU64(s, rk(id, "grace"), p.GraceBlocks)
	setU64(s, rk(id, "fb"), feeBps(s)) // fee snapshot (F-1)
	setMoney(s, rk(id, "pool"), mZero())

	// On-chain transparency metadata: human label, the settlement unit (always
	// the witness HBD/HIVE feed — a USD proxy, NOT real HIVE/USD), and the
	// creator this round is attributed to.
	setStr(s, rk(id, "label"), p.Label)
	setStr(s, rk(id, "unit"), SettleUnit)
	creator := p.Creator
	if creator == "" {
		creator = caller
	}
	setStr(s, rk(id, "creator"), creator)
	setU64(s, rk(id, "refprice"), p.ReferencePrice) // the %-move reference (the "why")

	// Publish the active-round pointer for this asset (id+1). Read by the frontend
	// as the "current round"; enforced by the one-open-round guard above.
	setU64(s, kActiveRound(p.Asset), id+1)
	return id, nil
}

// computeStrikes derives the six ±10/20/30% bucket boundaries from a reference
// price (same bps unit as the oracle feed): [ref−30%, ref−20%, ref−10%, ref+10%,
// ref+20%, ref+30%]. Six strikes ⇒ SEVEN mutually-exclusive buckets: 3 below, a
// middle "stays flat" band (±10%), and 3 above — so the most-likely near-flat
// outcome is always bettable (no dead middle). The frontend labels the strikes as
// concrete price thresholds and derives cumulative "P(above $X)" from the disjoint
// bucket pool shares (monotone by construction). Deterministic integer math → every
// node computes identical strikes; for a realistic bps price these are strictly
// increasing, and a degenerate tiny price that would collide boundaries is rejected
// by CreateRound's strictly-increasing check (RollRound retries when the feed is sane).
func computeStrikes(ref uint64) []uint64 {
	return []uint64{
		ref * 7 / 10,  // −30%
		ref * 8 / 10,  // −20%
		ref * 9 / 10,  // −10%
		ref * 11 / 10, // +10%
		ref * 12 / 10, // +20%
		ref * 13 / 10, // +30%
	}
}

// RollRound is the PERMISSIONLESS, decentralized round opener. Anyone may call
// it; it reads the reference price from the witness oracle (passed in from the
// wasm env), derives the 7 %-move buckets (±10/20/30%: 3 below, a middle "near
// current" band, 3 above) and the weekly timing DETERMINISTICALLY
// from protocol constants, and opens the round — so no operator chooses strikes
// or timing and there is nothing to cherry-pick. The one-open-round-per-asset
// guard in CreateRound prevents spam: a new round can only be rolled once the
// previous one has resolved. Rounds are attributed to "protocol" (no human
// created them).
func RollRound(s Store, block uint64, priceBps uint64, feedOK bool) (uint64, error) {
	if !feedOK {
		return 0, newErr(ErrOracle, "price feed not ok; cannot open a round without a valid reference price")
	}
	if priceBps == 0 {
		return 0, newErr(ErrOracle, "zero reference price")
	}
	if priceBps > MaxReferenceBps {
		return 0, newErr(ErrOracle, "reference price out of range")
	}
	return CreateRound(s, "protocol", block, CreateParams{
		Asset:          AssetHbd, // stake token = HBD (stable payout unit); settlement variable stays the HBD/HIVE feed
		Strikes:        computeStrikes(priceBps),
		LockBlock:      block + RollBettingBlocks,
		SettleBlock:    block + RollBettingBlocks + RollSettleGapBlocks,
		GraceBlocks:    RollGraceBlocks,
		Label:          "Where will HIVE close this week?",
		Creator:        "protocol",
		ReferencePrice: priceBps,
	})
}
