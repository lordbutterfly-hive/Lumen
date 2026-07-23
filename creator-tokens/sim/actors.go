package sim

import (
	"fmt"
	"math/big"
	"math/rand"
)

// Role is a named behaviour profile. Every actor in the population has
// exactly one. The four creator profiles are mutually exclusive ways of
// running a market; the four non-creator profiles are mutually exclusive
// ways of interacting with other people's markets. keeper and oracle are
// singleton/derived roles, not counted in --creators or --actors.
type Role string

const (
	RoleCreatorReliable   Role = "creator_reliable"    // answers nearly everything, promptly; renews on time
	RoleCreatorFlaky      Role = "creator_flaky"       // answers late, sometimes misses the deadline entirely
	RoleCreatorAbandoner  Role = "creator_abandoner"   // active for a while, then goes dark: stops answering AND renewing
	RoleCreatorPriceMover Role = "creator_price_mover" // changes face often within the band; also gets a synthetic TWAP feed

	RoleFan        Role = "fan"        // prepays, asks regularly, holds; occasionally renews a favourite creator
	RoleOneShot    Role = "one_shot"   // prepays exactly enough, asks once, leaves
	RoleSpeculator Role = "speculator" // buys credits across many creators, never asks, transfers/refunds opportunistically
	RoleTrader     Role = "trader"     // moves credits peer-to-peer; light on new HBD inflow after the initial stake

	RoleKeeper Role = "keeper" // sweeps FROZEN markets via the real keeper.Plan
	RoleOracle Role = "oracle" // synthetic per-market price feed for price_mover creators only (RecordObs)

	// RoleOwner is the singleton platform-owner actor (Upgrade 1 / C2 fix,
	// 2026-07-21 — see actions.go's doWithdrawTreasury and engine.go's
	// NewEngine, which binds this actor's name to core's kOwner() key the
	// same way contract/main.go's Init binds contract.owner). Before the C2
	// fix, this simulator had no reason to model an owner at all: kTreasury
	// had no exit anywhere in core, so a frozen (unwithdrawable) and a
	// withdrawable treasury rendered identically -- both just "sit." This
	// role exists specifically to drive the new exit and let the ledger
	// analysis assert it actually works, not merely that money conserves.
	RoleOwner Role = "owner"
)

// IsCreator reports whether r is one of the four market-owning profiles.
func (r Role) IsCreator() bool {
	switch r {
	case RoleCreatorReliable, RoleCreatorFlaky, RoleCreatorAbandoner, RoleCreatorPriceMover:
		return true
	}
	return false
}

// creatorRoles / holderRoles are the round-robin assignment orders used by
// NewPopulation — fixed, deterministic orderings so "8 creators" always
// produces the same profile mix for the same seed.
var creatorRoles = []Role{RoleCreatorReliable, RoleCreatorFlaky, RoleCreatorAbandoner, RoleCreatorPriceMover}
var holderRoles = []Role{RoleFan, RoleOneShot, RoleSpeculator, RoleTrader}

// Actor is one named participant. Every actor owns exactly one *rand.Rand,
// seeded deterministically from the run's master seed at population-
// construction time and never reseeded — every random decision that actor
// ever makes for the rest of the run draws from this one stream, which is
// what makes "replays exactly from its seed" true: the sequence of calls
// into this RNG is itself deterministic, because the engine's scheduler
// (engine.go) processes events in strict, tie-broken block order and never
// interleaves two actors' RNG draws within a single scheduled step.
//
// HBD is this actor's simulated off-chain wallet balance — a stand-in for
// their real Hive account's liquid HBD, since core itself never models a
// caller's wallet (core/API.md: money enters via sdk.HiveDraw at the wasm
// layer, which this package's actions.go reproduces explicitly). It is only
// ever debited/credited by actions.go, and only on a call that actually
// succeeded — see actions.go's coreCall convention.
type Actor struct {
	Name string
	Role Role
	RNG  *rand.Rand
	HBD  *big.Int
}

// Population is the full cast for one run, plus lookup indices the engine
// needs. Every name-keyed slice is in DETERMINISTIC construction order —
// never re-sorted, never iterated via a bare map range for anything that
// affects scheduling or trace order (see engine.go's determinism note).
type Population struct {
	Actors map[string]*Actor

	CreatorNames     []string // registration/generation order
	HolderNames      []string // fan/one_shot/speculator/trader, generation order
	KeeperName       string
	OwnerName        string            // singleton platform owner (Upgrade 1 / C2 fix) -- see RoleOwner's doc
	OracleForCreator map[string]string // price_mover creator name -> its oracle actor's name
}

// wallet funding ranges per role, in HBD base units (3dp: 1000 == 1.000
// HBD). Generous enough that a week or a quarter of organic activity almost
// never starves an actor outright — the interesting failure surface this
// simulator wants is CORE's own guards (caps, bands, deadlines, slippage),
// not "the simulated wallet ran dry," which is a sim artifact, not a core
// finding. See actions.go's affordability guards for how a wallet is
// clamped against, never overdrawn.
var walletRangeBase = map[Role][2]int64{
	RoleCreatorReliable:   {300_000, 600_000},
	RoleCreatorFlaky:      {200_000, 450_000},
	RoleCreatorAbandoner:  {150_000, 350_000},
	RoleCreatorPriceMover: {300_000, 600_000},
	RoleFan:               {60_000, 300_000},
	RoleOneShot:           {8_000, 40_000},
	RoleSpeculator:        {150_000, 700_000},
	RoleTrader:            {30_000, 120_000},
}

func randRangeInt64(rng *rand.Rand, lo, hi int64) int64 {
	if hi <= lo {
		return lo
	}
	return lo + rng.Int63n(hi-lo)
}

// NewPopulation builds the full cast deterministically from seed. Creator
// and holder counts are split round-robin across their four profiles
// (remainder goes to the earlier profiles in creatorRoles/holderRoles
// order), so "creators=8" always yields 2 of each of the 4 creator
// profiles for the same seed, "creators=9" yields 3/2/2/2, etc.
//
// masterRNG drives ONLY population construction (role assignment, per-actor
// seed derivation, wallet sizing, initial face/cap choices) — never a
// runtime behaviour decision. Every actor's own RNG, once constructed here,
// is what drives everything that happens to them for the rest of the run.
func NewPopulation(seed int64, numCreators, numActors int) *Population {
	masterRNG := rand.New(rand.NewSource(seed))

	pop := &Population{
		Actors:           map[string]*Actor{},
		OracleForCreator: map[string]string{},
	}

	deriveRNG := func() *rand.Rand {
		return rand.New(rand.NewSource(masterRNG.Int63()))
	}

	newActor := func(name string, role Role) *Actor {
		lo, hi := walletRangeBase[role][0], walletRangeBase[role][1]
		a := &Actor{
			Name: name,
			Role: role,
			RNG:  deriveRNG(),
			HBD:  big.NewInt(randRangeInt64(masterRNG, lo, hi)),
		}
		pop.Actors[name] = a
		return a
	}

	// ---- creators ----
	for i := 0; i < numCreators; i++ {
		role := creatorRoles[i%len(creatorRoles)]
		idx := i/len(creatorRoles) + 1
		name := fmt.Sprintf("creator-%s-%d", shortRole(role), idx)
		newActor(name, role)
		pop.CreatorNames = append(pop.CreatorNames, name)

		if role == RoleCreatorPriceMover {
			oracleName := "oracle-" + name
			newActor(oracleName, RoleOracle)
			pop.OracleForCreator[name] = oracleName
		}
	}

	// ---- non-creator actors ----
	for i := 0; i < numActors; i++ {
		role := holderRoles[i%len(holderRoles)]
		idx := i/len(holderRoles) + 1
		name := fmt.Sprintf("actor-%s-%d", shortRole(role), idx)
		newActor(name, role)
		pop.HolderNames = append(pop.HolderNames, name)
	}

	// ---- keeper (singleton, needs no HBD wallet: RefundHolder/CloseIfDrained
	// never draw HBD from their caller — see core/refund.go's RefundHolder
	// doc: "caller therefore plays NO role in any key this function reads or
	// writes") ----
	pop.KeeperName = "keeper-1"
	pop.Actors[pop.KeeperName] = &Actor{Name: pop.KeeperName, Role: RoleKeeper, RNG: deriveRNG(), HBD: zeroBig()}

	// ---- owner (singleton, Upgrade 1 / C2 fix — see RoleOwner's doc). Starts
	// at zero HBD like the keeper: WithdrawTreasury never draws FROM its
	// caller either (core/read.go: "core itself never moves HBD -- the wasm
	// wrapper is responsible for actually paying it out"), so this
	// simulator's own actor.HBD field for the owner is purely an
	// ACCUMULATOR of what it has successfully withdrawn, starting from
	// nothing owed. ----
	pop.OwnerName = "owner-1"
	pop.Actors[pop.OwnerName] = &Actor{Name: pop.OwnerName, Role: RoleOwner, RNG: deriveRNG(), HBD: zeroBig()}

	return pop
}

func shortRole(r Role) string {
	switch r {
	case RoleCreatorReliable:
		return "reliable"
	case RoleCreatorFlaky:
		return "flaky"
	case RoleCreatorAbandoner:
		return "abandoner"
	case RoleCreatorPriceMover:
		return "pricemover"
	case RoleFan:
		return "fan"
	case RoleOneShot:
		return "oneshot"
	case RoleSpeculator:
		return "speculator"
	case RoleTrader:
		return "trader"
	default:
		return string(r)
	}
}
