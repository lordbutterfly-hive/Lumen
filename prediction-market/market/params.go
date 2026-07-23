package market

// Tunable protocol parameters + fixed enums. Values chosen per the council
// review (see ../BUILD-MAP.md rev1).
const (
	// MaxFeeBps caps the protocol fee. The contract SHIPS WITH NO FEE
	// (DefaultFeeBps = 0 in admin.go): winners split the entire pool and the
	// market takes no operator rake — a house cut to a named beneficiary is a
	// legality problem and is inherently centralized. This ceiling only bounds a
	// fee IF one were ever enabled, and exists so the money-math fuzz tests can
	// still prove conservation across a fee range. The fee is snapshotted per
	// round (F-1), so a change never re-prices a live round.
	MaxFeeBps = 500

	// MaxOutcomes bounds per-round state + settle cost (ops P-2). A sane weekly
	// market is a handful of buckets; this stops a fat-finger/compromised-owner
	// createRound from ballooning cost.
	MaxOutcomes = 16

	// MinBet floors each stake (base units, 3-decimal HIVE/HBD ⇒ 1000 = 1.000)
	// to bound dust/state-spam (ops #1/#5). Defense-in-depth; the zero-dust
	// payout (F-2) is the primary anti-spam guarantee.
	MinBet = "1000"

	// SettleBounty is a small fixed keeper reward (base units) paid to whoever
	// calls settle, taken from the fee (never from stakes), so low-interest
	// rounds don't stall (ops P-1). Fixed (not %) to avoid a tick-timing
	// incentive. VOID has no bounty (stakers are self-incentivised to claim).
	SettleBounty = "100"

	// SettleBountyBps makes the keeper reward scale with pool size (a % of the
	// pool, still carved from the fee, capped at the fee). A fixed 100-unit
	// bounty is negligible on a large pool, so no keeper bothers to settle
	// promptly — which is exactly what lets a losing bettor PASSIVELY dodge by
	// riding the window out to a VOID refund (council DODGE / free-option). A
	// pool-proportional bounty guarantees someone settles the first valid tick.
	// It carries NO tick-timing incentive: the bounty depends on pool size, not
	// on WHEN you settle or WHICH bucket wins. The effective bounty is
	// max(SettleBounty, pool*SettleBountyBps/10000) capped at the round fee.
	SettleBountyBps = 20 // 0.20% of pool

	// Settle must land inside [settleBlock, settleBlock+SettleWindowBlocks];
	// past it unsettled ⇒ VOID (window_lapsed). The window bounds the OUTER
	// duration; MaxSettleTickLag (below) is what actually kills cherry-picking.
	SettleWindowBlocks = 1200 // ~1h at 3s blocks

	// MaxSettleTickLag pins settlement to the FIRST pendulum tick at/after
	// settleBlock. The pendulum ticks every DefaultTickIntervalBlocks (=100) and
	// hive_moving_avg_bps is CONSTANT between ticks, so requiring
	//   settleBlock <= tick_block_height < settleBlock + MaxSettleTickLag
	// makes EVERY settle call in that ~100-block window read the identical MA —
	// the settlement price becomes deterministic (chosen by settleBlock, not by
	// the caller's block), which removes the settle-timing cherry-pick (C1 /
	// redteam Attack 2). If the prompt tick is missed (tick advances past it),
	// settle VOIDs (tick_window_missed) rather than letting a later, cherry-
	// picked tick decide. Set to one tick interval so exactly one tick qualifies.
	// (This is a contract-side MITIGATION: it pins to the first-tick-after-settle,
	// not the exact-settleBlock price — a deterministic <100-block offset, not
	// attacker-controllable. A perfect fix still wants an oracle tick_history key.)
	MaxSettleTickLag = 100

	// Minimum lock→settle gap so the price can move between lock and settle —
	// no one bets at lock knowing the near-final settle price (F-5 / review #2).
	MinSettleGapBlocks = 1200 // ~1h

	// MaxRoundHorizonBlocks caps how far in the future lock/settle may be set at
	// create. Without an upper bound, an owner (rogue, compromised, or a tooling
	// fat-finger) can set settleBlock astronomically far so the round can NEVER
	// settle or void → staked funds locked forever (NEW-1 permanent-freeze). It
	// also keeps every timing sum far below 2^64 (defense-in-depth vs the grace
	// overflow, C2). ~30 days at 3s blocks.
	MaxRoundHorizonBlocks = 864000

	// MaxGraceBlocks caps the extra VoidStale delay so settleBlock+window+grace
	// can never overflow uint64 (C2) and grace can't be weaponized into an
	// early/never VoidStale. ~1 day at 3s blocks.
	MaxGraceBlocks = 28800

	// ── Permissionless round roll (decentralized creation) ──────────────────
	// Rounds are opened by ANYONE via the on-chain `roll` action, which reads the
	// witness oracle for the reference price and derives the strikes + timing
	// DETERMINISTICALLY from these constants — so no operator chooses them and
	// there is nothing to cherry-pick. Weekly rhythm: ~5 days open for betting,
	// then ~2 days to settle. Both within MaxRoundHorizonBlocks; the lock→settle
	// gap exceeds MinSettleGapBlocks. Tunable protocol constants.
	RollBettingBlocks   = 144000 // ~5 days open for betting (roll block → lock)
	RollSettleGapBlocks = 57600  // ~2 days from lock to settle
	RollGraceBlocks     = 2400   // ~2h grace before a stale round can be force-voided

	// MaxReferenceBps bounds the oracle reference price RollRound accepts, so
	// computeStrikes' ref*13/10 can never approach a uint64 wrap (defense-in-depth:
	// the real HBD/HIVE feed is thousands of bps; this cap ≈ HIVE at $10,000 —
	// absurdly high yet ~11 orders of magnitude below the overflow point).
	MaxReferenceBps = 100000000 // 100M bps

	AssetHive = "hive"
	AssetHbd  = "hbd"

	// Stored round state. "locked" is DERIVED (state==open && block>=lock), never
	// stored — bet gates on block<lock directly (fund-safety F-5). settle/void
	// gate on state==open and flip to a terminal state (F-3).
	StateOpen    = "open"
	StateSettled = "settled"
	StateVoid    = "void"

	// BoundaryUpper: a settle price exactly on a strike belongs to the UPPER
	// bucket. Deterministic, consensus-safe, documented (oracle boundary rule).

	// SettleUnit is the on-chain label for what settlement is measured in: the
	// witness HBD/HIVE feed (a USD proxy via the HBD peg, NOT real HIVE/USD).
	SettleUnit = "HBD/HIVE"

	// MaxLabelLen bounds the human market label stored on-chain.
	MaxLabelLen = 200

	// Void reason codes recorded on a VOID round (rd|<id>|vr), so a user always
	// knows WHY a round voided rather than seeing an unexplained refund.
	VoidUnderfunded     = "underfunded"       // fewer than 2 outcomes funded
	VoidZeroWinner      = "zero_winner"       // the winning bucket had no stakers
	VoidWindowLapsed    = "window_lapsed"     // nobody settled within the settle window
	VoidStaleFeed       = "stale_feed"        // feed stayed not-ok past the grace window
	VoidTickWindowMissed = "tick_window_missed" // no valid settle used the first tick after settleBlock (C1 mitigation)
	VoidDeadlineReclaim  = "deadline_reclaim"   // a staker force-voided a STUCK round past the settle deadline to return funds (fail-safe; see reclaim.go)

	// ClaimWindowBlocks — how long after settleBlock stakers have to claim a
	// resolved round before UNCLAIMED funds (winnings a winner never took, or a
	// refund a staker abandoned, including because their account can't receive)
	// may be swept to the DHF (sweep.go). Deliberately generous so no legitimate
	// late claimer is ever cut off. ~90 days at 3s blocks; bounded well under
	// 2^64 together with settleBlock (MaxRoundHorizonBlocks), so
	// settleBlock+ClaimWindowBlocks cannot overflow.
	ClaimWindowBlocks = 2592000 // ~90 days

	// DHFAccount is Hive's Decentralized Hive Fund (@hive.fund). Unclaimed round
	// funds are UNMAPPED to it (sdk.HiveWithdraw — L2→L1) after ClaimWindowBlocks
	// rather than burned or left stranded, so abandoned money benefits the
	// community. Withdraw (not transfer) is deliberate: the DHF is an L1
	// institution, so the funds must land on L1, not sit as an L2 balance.
	DHFAccount = "hive:hive.fund"
)

// isNativeAsset reports whether asset is a native VSC ledger asset. The market
// is native-only in v0 (F-6): the exact-transfer assumption (received==requested)
// only holds for native HIVE/HBD.
func isNativeAsset(asset string) bool {
	return asset == AssetHive || asset == AssetHbd
}
