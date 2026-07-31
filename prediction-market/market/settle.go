package market

import "math/big"

// SettleResult tells the wasm layer what to do after resolution: the terminal
// state, the winning outcome (if SETTLED), and any keeper bounty to transfer to
// the settle caller.
type SettleResult struct {
	State  string
	Winner int
	Bounty *big.Int
	Asset  string
	Reason string // void reason code (empty when SETTLED)
}

// Settle resolves a LOCKED round from the oracle price. `priceBps` is the
// 15-min MA (hive_moving_avg_bps); `feedOK` MUST be
// (pendulum.hive_ma_ok && pendulum.trusted_hive_mean_ok) — the MA "ok" alone
// never expires (oracle O-1/O-2). `tickHeight` is recorded for audit.
//
// Gates (order matters): state==OPEN first (F-3, cheap terminal-state reject),
// then block>=settleBlock. Past settleBlock+SettleWindowBlocks unsettled ⇒ VOID
// (bounds tick cherry-picking). Degenerate markets (<2 outcomes funded, or the
// winning outcome empty) ⇒ VOID (E-2). Otherwise SETTLED.
func Settle(
	s Store, caller string, block uint64, id uint64,
	priceBps uint64, tickHeight uint64, feedOK bool,
) (*SettleResult, error) {
	if !roundExists(s, id) {
		return nil, newErr(ErrNotFound, "no such round")
	}
	if roundState(s, id) != StateOpen {
		return nil, newErr(ErrState, "round already resolved")
	}
	settleBlock := getU64(s, rk(id, "settle"))
	if block < settleBlock {
		return nil, newErr(ErrState, "too early to settle")
	}
	asset := getStr(s, rk(id, "asset"))

	if block > settleBlock+SettleWindowBlocks {
		return doVoid(s, id, asset, VoidWindowLapsed), nil
	}
	if !feedOK {
		return nil, newErr(ErrOracle, "price feed not ok; retry in window or voidStale after grace")
	}
	// C1 mitigation — pin settlement to the FIRST pendulum tick at/after
	// settleBlock. hive_moving_avg_bps is constant between ticks, so once
	// tick_block_height is bound to [settleBlock, settleBlock+MaxSettleTickLag)
	// every settle call in that window reads the identical MA: the winner is
	// determined by settleBlock, not by the caller's chosen block → no
	// cherry-picking. A pre-settle tick is rejected; a tick past the prompt
	// window (nobody settled the first tick) ⇒ VOID rather than let a later,
	// caller-chosen tick decide.
	if tickHeight < settleBlock {
		return nil, newErr(ErrOracle, "oracle tick precedes settle block; wait for the first tick at/after settleBlock")
	}
	if tickHeight >= settleBlock+MaxSettleTickLag {
		return doVoid(s, id, asset, VoidTickWindowMissed), nil
	}

	n := roundN(s, id)
	funded := 0
	for k := 0; k < n; k++ {
		if !mIsZero(getMoney(s, rkOutcomePool(id, k))) {
			funded++
		}
	}
	if funded < 2 {
		return doVoid(s, id, asset, VoidUnderfunded), nil
	}

	winner := bucketFor(priceBps, roundStrikes(s, id))
	winPool := getMoney(s, rkOutcomePool(id, winner))
	if mIsZero(winPool) {
		return doVoid(s, id, asset, VoidZeroWinner), nil
	}

	// SETTLED. Fee from the round's snapshot (F-1); keeper bounty from the fee
	// only (never from stakes); the rest accrues to the withdrawable fee balance.
	pool := getMoney(s, rk(id, "pool"))
	fee := mMulBpsDiv(pool, getU64(s, rk(id, "fb")))
	distributable, err := mSub(pool, fee)
	if err != nil {
		return nil, err
	}
	bounty := computeBounty(pool, fee)
	feeRest, err := mSub(fee, bounty)
	if err != nil {
		return nil, err
	}
	addMoney(s, kFeeAccrued(asset), feeRest)

	setStr(s, rk(id, "state"), StateSettled)
	setU64(s, rk(id, "win"), uint64(winner))
	setU64(s, rk(id, "price"), priceBps)
	setU64(s, rk(id, "tick"), tickHeight)
	// Zero-dust running remainders (F-2): claims floor(stake*drem/wrem) and
	// decrement both, so Σ claims == distributable exactly (last claimant gets
	// the remainder). No dust sweep, no staker enumeration.
	setMoney(s, rk(id, "wrem"), winPool)
	setMoney(s, rk(id, "drem"), distributable)
	setMoney(s, rk(id, "owed"), distributable) // staker escrow still owed; residue → DHF (sweep.go)

	return &SettleResult{State: StateSettled, Winner: winner, Bounty: bounty, Asset: asset}, nil
}

// VoidStale forces VOID once block >= settleBlock + grace and the round is still
// OPEN (persistent bad feed). Permissionless liveness (no stuck funds, inv. #2).
func VoidStale(s Store, caller string, block uint64, id uint64) (*SettleResult, error) {
	if !roundExists(s, id) {
		return nil, newErr(ErrNotFound, "no such round")
	}
	if roundState(s, id) != StateOpen {
		return nil, newErr(ErrState, "round already resolved")
	}
	settleBlock := getU64(s, rk(id, "settle"))
	grace := getU64(s, rk(id, "grace"))
	// F-P4: mirror reclaim's zero-settle guard. A well-formed round always has
	// settle>0 (create.go:89-94); getU64→0 on corrupt/missing state would collapse
	// the deadline gate below and let VoidStale fire far too early. Refuse
	// explicitly on a zero/corrupt settle height.
	if settleBlock == 0 {
		return nil, newErr(ErrState, "round has no settle height; refusing (corrupt round state)")
	}
	// VoidStale may fire only STRICTLY AFTER the settle window has fully elapsed
	// (plus any extra grace), so it can never preempt a healthy, still-settleable
	// round during the window — a losing bettor can't race a refund to dodge a
	// loss (review finding 1). The comparison is `<=` (fire only when
	// block > settleBlock+SettleWindowBlocks+grace) so that at grace==0 it can
	// never coincide with settle()'s own last legitimate block (settle uses
	// strict `>`); the earlier `<` created a 1-block settle-vs-void race (C3).
	// grace is bounded (MaxGraceBlocks) and settle by MaxRoundHorizonBlocks, so
	// this sum cannot overflow uint64 (C2). During the window, settle() is the
	// only resolver.
	if block <= settleBlock+SettleWindowBlocks+grace {
		return nil, newErr(ErrState, "settle window not elapsed")
	}
	return doVoid(s, id, getStr(s, rk(id, "asset")), VoidStaleFeed), nil
}

func doVoid(s Store, id uint64, asset string, reason string) *SettleResult {
	setStr(s, rk(id, "state"), StateVoid)
	setStr(s, rk(id, "vr"), reason)
	// The full pool is now refundable to stakers; track it as owed so any residue
	// never claimed within the window can be swept to the DHF (sweep.go).
	setMoney(s, rk(id, "owed"), getMoney(s, rk(id, "pool")))
	return &SettleResult{State: StateVoid, Asset: asset, Bounty: mZero(), Reason: reason}
}

// computeBounty = min(fee, max(SettleBounty, pool*SettleBountyBps/10000)) —
// a pool-proportional keeper reward (with a small fixed floor) carved from the
// fee, never from stakes. Scaling with pool size guarantees a keeper always has
// reason to settle the first valid tick, which closes the passive-dodge /
// free-option (a losing bettor can no longer count on nobody settling). Bounty
// depends only on pool size, never on WHEN you settle or WHICH bucket wins, so
// it introduces no tick-timing incentive.
func computeBounty(pool, fee *big.Int) *big.Int {
	floor, _ := parseMoney(SettleBounty)
	b := mMulBpsDiv(pool, SettleBountyBps)
	if mLt(b, floor) {
		b = floor
	}
	if mLt(fee, b) { // never exceed the round's own fee
		return new(big.Int).Set(fee)
	}
	return b
}
