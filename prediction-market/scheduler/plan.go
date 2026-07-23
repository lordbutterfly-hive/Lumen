package scheduler

import "hive-price-market/market"

// Config holds the scheduler's deploy-time identifiers (network/contract/RC
// budget) plus the asset this scheduler instance tracks. Round timing
// (lock/settle/grace) and strikes are NO LONGER an off-chain planning
// concern: the permissionless `roll` action (contract/main.go's Roll
// handler, market.RollRound) derives them ALL on-chain, deterministically,
// from env + protocol constants (market.RollBettingBlocks/
// RollSettleGapBlocks/RollGraceBlocks, market/create.go's computeStrikes) —
// see ops.go's BuildRollOp doc for why. The old RoundPlan/PlanRound/
// ComputeStrikes machinery this package carried (for the pre-re-skin,
// caller-supplied createRound flow) has been removed accordingly; there is
// nothing left to plan beyond "should we roll right now" (RunRollCycle's
// overlap + feed-health guards).
type Config struct {
	NetID      string // Hive custom_json "net_id" (deploy-time network identifier)
	ContractID string // target contract id ("vsc1...")
	RCLimit    uint64 // rc_limit attached to every op this scheduler builds

	// Asset is the round asset this scheduler instance tracks for the
	// overlap guard (IsRoundOpen/ReadActiveRoundSchedule key on
	// "active|"+Asset) and the settle-keeper's round discovery. It MUST
	// match whatever `roll` actually creates: market.RollRound
	// (market/create.go:157-166) hardcodes `Asset: AssetHbd` — "stake token
	// = HBD (stable payout unit); settlement variable stays the HBD/HIVE
	// feed" — NOT a caller choice. Defaulting this to market.AssetHive (the
	// old, pre-re-skin default) would make the overlap guard and the
	// keeper's round discovery watch the WRONG state key ("active|hive"
	// instead of "active|hbd") and silently never find the round `roll`
	// actually opens — this is exactly the "5-bucket HIVE → 7-bucket HBD"
	// re-skin the scheduler had gone stale on.
	Asset string
}

// DefaultConfig returns sane deploy-time defaults. NetID/ContractID/RCLimit
// are placeholders — the real values are deploy-time config, not derivable
// here (see DEPLOY-RUNBOOK.md). Asset is fixed to market.AssetHbd to match
// RollRound's hardcoded choice (see the Config.Asset doc above) — this is
// NOT a free choice for a caller to override unless the contract's own
// RollRound is ever changed to support multiple assets.
func DefaultConfig(contractID string) Config {
	return Config{
		NetID:      "vsc-testnet", // placeholder — the real net_id is deploy-time config, not derivable here
		ContractID: contractID,
		RCLimit:    5000,
		Asset:      market.AssetHbd,
	}
}

func (c Config) opConfig() OpConfig {
	return OpConfig{NetID: c.NetID, ContractID: c.ContractID, RCLimit: c.RCLimit}
}
