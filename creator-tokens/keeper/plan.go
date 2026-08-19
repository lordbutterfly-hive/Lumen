package keeper

import (
	"fmt"
	"math/big"
	"sort"

	"creator-tokens/core"
)

// OpKind identifies which wasmexport action an Op submits. The two values
// map 1:1 onto contract/main.go's `refundHolder` and `closeIfDrained`
// entrypoints — the only two actions this package ever builds, matching
// SPEC §1.7.5 point 2's own description of the keeper's entire job ("walks
// the holder list at wind-down and refunds everyone").
type OpKind int

const (
	OpRefundHolder OpKind = iota
	OpCloseIfDrained
)

func (k OpKind) String() string {
	switch k {
	case OpRefundHolder:
		return "refundHolder"
	case OpCloseIfDrained:
		return "closeIfDrained"
	default:
		return "unknown"
	}
}

// Op is one action Plan decided is worth submitting. Holder and Balance are
// the zero value for OpCloseIfDrained, which takes no holder
// (contract/main.go:767's payload is just {"creator":"..."}).
type Op struct {
	Kind    OpKind
	Creator string
	Holder  string
	Balance *big.Int // advisory only — carried through for logging/dry-run display; see Plan's doc
}

// Op.String is used for logging and dry-run display; kept independent of the
// wire encoding in wire.go so a log line never depends on JSON tag names.
func (op Op) String() string {
	switch op.Kind {
	case OpRefundHolder:
		return fmt.Sprintf("refundHolder(creator=%s, holder=%s)", op.Creator, op.Holder)
	case OpCloseIfDrained:
		return fmt.Sprintf("closeIfDrained(creator=%s)", op.Creator)
	default:
		return fmt.Sprintf("unknown-op(creator=%s)", op.Creator)
	}
}

// Plan is the sweep algorithm: given a snapshot of markets, decide every
// refundHolder/closeIfDrained call worth submitting, and in what order. It
// is a pure function — deterministic, no I/O, no clock — feed it the same
// input twice and get the same []Op back twice. That determinism is where
// this package's crash-safety property starts: Plan has no memory of a
// previous run, so "resume after a crash" is nothing more than "call Plan
// again against a fresher snapshot" (see the package doc, and
// keeper_integration_test.go for a proof against the real core package).
//
// ---- which markets are actionable --------------------------------------
//
// A market is actionable when it is in WIND-DOWN, which core defines
// (core/market.go's inWindDown) as RETIRED **or** FROZEN — and this predicate
// mirrors that, rather than approximating it.
//
// CORRECTION 2026-07-28: this paragraph used to say only FROZEN markets
// produce ops, justified as "there is no separate on-chain WIND-DOWN state to
// check for ... so 'frozen' IS 'wind-down open,' by construction." That was
// false. core.Phase() is MAX(naturalPhase, retiredPhase), so a creator who
// Retires while still paid up reads OVERDUE for the entire GraceBlocks notice
// window — while core.inWindDown has been true since the retire block and
// core.RefundHolder will pay out. Filtering on FROZEN alone made Plan return
// zero ops for such a market for up to GraceBlocks. Nothing was ever stuck
// (Refund is a self-serve pull, open the instant inWindDown is true, and the
// push is permissionless for any third party), so the cost was delayed
// convenience — but a keeper that silently does nothing is indistinguishable
// from a broken one, and the claim contradicted the invariant it asserted.
//
// ACTIVE/OVERDUE markets that are NOT retired have nothing due yet (nothing
// here decides subscription reminders — that is a frontend concern, SPEC
// §2.1.A.1). CLOSED markets are terminal and already fully wound down —
// CloseIfDrained only ever sets CLOSED once supply reaches zero (refund.go's
// own I3 argument) — so there is structurally nothing left to refund or
// close, retired or not.
//
// ---- "verify, don't trust" ------------------------------------------------
//
// A holder-discovery source — the Magi indexer's lumen_ct_balances view
// (../magi-indexer/creator_tokens_views.yaml) — reports only non-zero balances
// AT INDEX TIME. Plan does not take that on faith:
// every candidate's attached Balance is checked (non-nil, strictly positive)
// before it is allowed to produce a refundHolder op. Be precise about what
// this buys, because it would be easy to oversell: it is a COST
// optimisation, not a safety one. core.RefundHolder re-derives the true
// payout from LIVE reserve, supply and the holder's own LIVE balance at call
// time — never from anything Plan or this package supplies (core/refund.go).
// A candidate that is merely stale — refunded by someone else between the
// indexer's snapshot and this call — costs nothing worse than a transaction
// that turns out to be a documented harmless no-op: "A holder with a zero
// balance is a harmless no-op: (0, nil), no state touched" (core/refund.go's
// RefundHolder doc). This check exists to skip that wasted transaction where
// the information to skip it is already sitting in the snapshot, not because
// omitting it would ever risk an over-payment: it structurally cannot,
// because this package is never the source of truth for what anyone is
// owed. A TRUE fix for staleness (re-reading a holder's balance from the
// chain immediately before submitting, rather than trusting even a moment-old
// snapshot) needs a live read and is deliberately left to the caller that
// assembles MarketView — see the package doc's note on why this package
// itself performs no I/O.
//
// ---- ordering --------------------------------------------------------------
//
// Markets: sorted by Creator, ascending — deterministic, and matches the
// indexer's own "sorted for determinism" convention (index.go's HolderList).
//
// Holders within a market: largest Balance first, Holder name ascending as a
// stable tie-break. This was a real choice worth stating plainly: since the
// keeper is never load-bearing (every holder can always self-serve, or be
// pushed by any other third party, regardless of the order this package
// picks), ordering cannot be a SAFETY decision here — only a courtesy one.
// Largest-balance-first bounds the total HBD value still sitting unclaimed
// in a market if a sweep is interrupted partway through (a crash, an RC
// exhaustion, a process kill), which is the friendlier default; alphabetical
// ordering has no offsetting advantage beyond being marginally easier to
// eyeball in a log, and this package's tests (plan_test.go) already give a
// deterministic, reproducible order either way.
//
// ---- closeIfDrained ---------------------------------------------------
//
// Exactly one OpCloseIfDrained is appended per FROZEN market, always LAST
// (after every refundHolder op for that market), and UNCONDITIONALLY — even
// for a market whose Holders list is already empty (fully swept by a prior
// run), and even though it may still be a no-op today because of an
// outstanding escrow (I3: supply also counts escrowed credits, which
// Holders/BalanceOf never see — SPEC §1.7.5: "In-flight asks are never cut
// off... A creator mid-answer when the subscription lapses still gets paid
// for finishing the work"). core.CloseIfDrained is documented idempotent and
// is cheap to call when it does nothing — the same reasoning the imitated
// template applies to its own periodic fee sweep ("it's always safe to call
// speculatively... a keeper can just call this on a fixed schedule ... without
// first checking the accrued balance off-chain," hive-price-market/
// scheduler/scheduler.go's RunFeeSweep doc). Calling it unconditionally on
// every sweep means a market that only finishes draining because its LAST
// open escrow resolves days after every holder was already refunded still
// gets closed on the very next sweep, with no extra bookkeeping anywhere
// tracking "was this market's holder list the last outstanding thing."
func Plan(markets []MarketView) []Op {
	sorted := make([]MarketView, len(markets))
	copy(sorted, markets)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Creator < sorted[j].Creator })

	var ops []Op
	for _, m := range sorted {
		// Mirrors core's inWindDown, which is (retired OR frozen) — NOT frozen
		// alone. A retired market is in wind-down from the retire block, while
		// Phase still reads OVERDUE for the whole notice window; filtering on
		// Frozen alone made Plan blind to it. See MarketView.Retired's doc.
		// CLOSED is deliberately excluded: nothing is left to sweep.
		if m.Phase == core.StateClosed || (m.Phase != core.StateFrozen && !m.Retired) {
			continue
		}

		holders := make([]HolderBalance, 0, len(m.Holders))
		for _, h := range m.Holders {
			if h.Balance == nil || h.Balance.Sign() <= 0 {
				continue // verify, don't trust — see doc above
			}
			if h.RefundBlocked {
				// F9 FIX (2026-08-19): core/refund.go:479-486's exit-tax /
				// wind-down-DoS-backstop gate would refuse this exact push —
				// see HolderBalance.RefundBlocked's doc for the predicate
				// (core.RefundHolderTaxGateBlocked) this mirrors, called by
				// the caller that built this snapshot. Emitting the op
				// anyway would be a doomed transaction: it wastes the
				// keeper's RC, and — before the sweep.go honesty fix
				// alongside this one — Sweep would have reported the revert
				// as a completed payment. The holder is never stuck: the
				// self-serve pull (core.Refund) is open the instant
				// wind-down begins, taxed at their own decaying clock, and
				// this same holder becomes plannable again the moment
				// either their own clock finishes decaying or the market's
				// backstop opens — Plan is stateless and re-derives this on
				// every call against a fresh snapshot, so nothing needs to
				// remember to retry them.
				continue
			}
			holders = append(holders, h)
		}
		sort.Slice(holders, func(i, j int) bool {
			if c := holders[i].Balance.Cmp(holders[j].Balance); c != 0 {
				return c > 0 // largest first
			}
			return holders[i].Holder < holders[j].Holder // deterministic tie-break
		})

		for _, h := range holders {
			ops = append(ops, Op{Kind: OpRefundHolder, Creator: m.Creator, Holder: h.Holder, Balance: h.Balance})
		}
		ops = append(ops, Op{Kind: OpCloseIfDrained, Creator: m.Creator})
	}
	return ops
}
