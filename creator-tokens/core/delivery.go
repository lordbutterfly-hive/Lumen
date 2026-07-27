package core

// delivery.go — the DELIVERY GATE (RULING E, built 2026-07-27 on a USER
// RULING). The subscription proves a creator is still THERE; this proves they
// are still DELIVERING.
//
// THE HOLE THIS FILLS. Until this file existed, a creator could pay the
// subscription forever, never answer a single ask, and face no consequence
// whatsoever: every unanswered ask was simply reclaimed by its asker, the
// creator earned nothing from it, and the market went on selling tokens and
// accepting new asks as if nothing were wrong. Nobody was robbed — but the one
// mechanism that was supposed to make this product different from friend.tech
// (a creator who stops delivering stops selling) was ruled, documented as
// binding in RULINGS-v2, and never built.
//
// WHAT COUNTS AS A MISS, and why it needs no oracle. An escrow still PENDING
// at deadline+ReclaimGrace was not delivered. That is a fact about state and a
// block height — no judgement, no committee, no price feed, nothing to
// manipulate. It is recorded when the escrow is actually reclaimed (ask.go's
// Reclaim), which is the first moment any transaction touches that escrow
// again; Reclaim is permissionless once its window opens and returns the
// asker's money in full, so the asker (or anyone) is motivated to call it.
//
// WHY GRIEFING DOES NOT WORK. A hostile asker who wants to manufacture misses
// must pay for each ask (credits plus a real HBD commission) and then wait out
// the deadline. The creator can kill every one of them for free with Decline —
// a full refund including the commission, explicitly NOT a miss. So the only
// way to accumulate misses is to ignore paying customers, which is precisely
// the behaviour being penalised. A miss is negligence, never bad luck.
//
// WHAT DELINQUENCY DOES, and the guardrail it must never cross. Crossing the
// threshold refuses INFLOWS — no new buys, no new asks — for a fixed penalty
// window. It touches NO outflow: selling, refunding, reclaiming, answering an
// ask already in flight, claiming trade fees and claiming the exit-tax share
// all keep working exactly as before, in every phase, forever. This is the
// standing guardrail (never let non-payment or non-delivery gate funds), and
// delivery standing is deliberately checked ONLY inside RequireInflowOpen so
// there is exactly one place it can ever bite.

// recordDelivery marks one escrow resolved in the creator's favour — an
// Answer, or a Decline. Both count: declining fast is a legitimate way to run
// a shop, and treating it as anything less than delivery would push creators
// to ignore asks they cannot take rather than say so.
// asker is passed so a SELF-DEALT escrow can be excluded. Both counters
// deliberately ignore any escrow whose asker is the creator themselves.
//
// WHY (defect found by code review, 2026-07-27). Decline is a complete
// round-trip refund — credits AND the whole commission come back — so a
// creator asking their own market and declining it costs nothing but
// transaction fees, and each cycle incremented the delivered count. The miss
// RATE is misses/(misses+delivered), so a creator could pump the denominator
// arbitrarily and hold the ratio under MaxMissBps forever while ignoring every
// real customer. The gate would then never fire, no matter how many people
// were left waiting. Excluding self-deals removes the free denominator; a
// creator can still pad using a second account, but that is the sybil floor
// this whole codebase prices rather than pretends to close, and the indexer's
// public delivery record already excludes self-deals on the same reasoning
// (indexer/index.go's SelfDealtExcluded).
func recordDelivery(s Store, creator, asker string) {
	if asker == creator {
		return
	}
	setU64(s, kDeliveredCount(creator), getU64(s, kDeliveredCount(creator))+1)
}

// recordMiss marks one escrow that reached its reclaim window still pending,
// then re-assesses standing. Called from Reclaim, which by its own window
// guard can only ever run on an escrow that was never answered or declined.
//
// INFALLIBLE BY CONSTRUCTION (RULING G): this writes counters and, at worst,
// one block height. It returns nothing and can refuse nothing, so it can never
// be the reason an outflow reverts — Reclaim is an outflow, and it must
// complete for the asker whether or not this is the miss that tips the
// creator over.
func recordMiss(s Store, creator, asker string, block uint64) {
	// Self-dealt escrows count for NEITHER side, symmetric with
	// recordDelivery: a creator cannot pad their record with their own asks,
	// and equally cannot be convicted by ignoring their own. Excluding one
	// side but not the other would just move the lever.
	if asker == creator {
		return
	}
	misses := getU64(s, kMissCount(creator)) + 1
	setU64(s, kMissCount(creator), misses)

	delivered := getU64(s, kDeliveredCount(creator))
	if !overMissThreshold(misses, delivered) {
		return
	}
	// Serve one fixed penalty window and RESET the counters. The reset is what
	// makes this escapable: the creator comes out of it with a clean sheet
	// rather than back into the same convicting ratio (see DelinquencyBlocks).
	//
	// The window EXTENDS rather than restarts from scratch if one is somehow
	// already running (it cannot be today — the counters are zeroed here, so a
	// second crossing needs MinMissesForDelinquency fresh misses — but taking
	// the max costs one comparison and guarantees a re-offence can never
	// SHORTEN an unexpired penalty).
	until := block + DelinquencyBlocks
	if cur := getU64(s, kDelinquentUntil(creator)); cur > until {
		until = cur
	}
	setU64(s, kDelinquentUntil(creator), until)
	setU64(s, kMissCount(creator), 0)
	setU64(s, kDeliveredCount(creator), 0)
}

// overMissThreshold is the whole judgement, in one place, on integers only:
// enough misses to be a sample, and a miss RATE above the ruled ceiling.
func overMissThreshold(misses, delivered uint64) bool {
	if misses < MinMissesForDelinquency {
		return false
	}
	resolved := misses + delivered
	if resolved == 0 {
		return false // unreachable: misses >= 3 implies resolved >= 3
	}
	// misses/resolved > MaxMissBps/10000, cross-multiplied so there is no
	// division and no float anywhere in the decision.
	return misses*10000 > resolved*MaxMissBps
}

// DeliveryStanding reports whether a creator is currently delinquent and, if
// so, the block their penalty window ends — the read a wallet or UI needs to
// explain WHY an inflow is being refused, instead of showing a dead Buy button
// with no reason. Zero writes.
//
// It is a separate read from Phase() on purpose: a creator can be perfectly
// paid up and still delinquent, or lapsed and delivering fine, and collapsing
// those two independent facts into one state string would lose exactly the
// distinction this gate exists to draw.
func DeliveryStanding(s Store, creator string, block uint64) (delinquent bool, until uint64) {
	until = getU64(s, kDelinquentUntil(creator))
	return block < until, until
}

// DeliveryRecord exposes the raw counters behind the standing, so a creator
// can see how close they are to the line before they cross it (and an indexer
// can show a buyer the same). Zero writes.
func DeliveryRecord(s Store, creator string) (misses, delivered uint64) {
	return getU64(s, kMissCount(creator)), getU64(s, kDeliveredCount(creator))
}
