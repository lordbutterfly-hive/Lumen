// Package keeper is the off-chain automation for Magi Creator Keys' wind-down
// (SPEC-CREATOR-KEYS.md §1.7.5, "the lapse ladder — warn, freeze at day 5,
// return"). Once a market has been FROZEN for the full lapse ladder, every
// holder's credits become refundable pro-rata against the reserve. Nothing on
// Magi can fire that refund on a timer: there is no on-chain scheduler, and a
// contract cannot pay N holders unprompted, because every transaction needs an
// external signer to submit and pay for it (core/API.md rule 1: "No scheduler
// exists. Every time-based transition is computed lazily inside the call that
// needs it. Nothing may assume a keeper ran."). The contract's answer is
// `refundHolder`: permissionless, and structurally incapable of paying anyone
// but the named holder — `caller` never participates in any key it reads or
// writes (core/refund.go's RefundHolder doc). This package walks a market's
// holder list at wind-down and submits those calls, so the user experience is
// automatic — SPEC §1.7.5 point 2: "We run a keeper... That produces
// genuinely automatic UX for the user."
//
// THE GOVERNING RULE, restated so it cannot be missed anywhere this package
// is read: the keeper is an OPTIMISATION, never a DEPENDENCY. If this
// package is dead, offline, out of resource credits, or actively hostile,
// every holder can still self-refund via `refund` (core.Refund, the pull
// half of the same mechanism), and any third party — not just this keeper —
// can push `refundHolder` on any holder's behalf. Nothing in the contract
// changes behaviour based on whether a "keeper" ran; core.RefundHolder does
// not know this package exists, has no way to know, and was written so that
// it never needs to. SPEC §1.7.5 names, in so many words, the failure mode
// this package exists to avoid: "This is the rule the weekly price market
// violated, and its one open MEDIUM is the result" — hive-price-market's own
// settle keeper IS load-bearing (nothing else settles a round the instant
// it's due; a dead settle keeper delays, at worst, a payout everyone still
// eventually gets via the round's own auto-VOID lapse path, which is exactly
// why that gap is a MEDIUM and not a HIGH — but it is still a real gap this
// package is built not to have at all).
//
// Consequently, everything this package decides is phrased as a SHOULD,
// never a MUST: a holder who is never swept is INCONVENIENCED (they wait, or
// self-serve, or wait for a stranger to push it for them), never HARMED.
// core.RefundHolder computes a holder's payout from LIVE on-chain state at
// call time — reserve, supply, and the holder's own balance — never from
// anything this package supplies. A slow, stale, buggy or actively malicious
// keeper cannot cause an over-payment or a mispayment to the wrong account;
// the worst it can do is delay a payment that was always self-servable, or
// waste RC on a submission that turns out to be a documented harmless no-op.
// See plan.go's doc for exactly where the task's "verify, don't trust"
// requirement matters (cost) and where it structurally can't (safety).
//
// Package shape: pure decision logic (MarketView -> Plan -> []Op) plus one
// I/O seam (the Submitter interface) — mirrors
// hive-price-market/scheduler/{keeper,scheduler,broadcaster}.go, the
// template this package imitates end to end. It deliberately does NOT import
// creator-tokens/contract (TinyGo/wasm build-constrained, and the whole
// point of this package's own test suite is to run under plain `go test`
// with no TinyGo toolchain); it imports creator-tokens/core ONLY for the
// four StateXxx phase constants (params.go), so this package's notion of
// "frozen" can never silently drift from the contract's own — exactly the
// reason the imitated template imports hive-price-market/market for its
// enums instead of redefining them locally.
package keeper

import "math/big"

// HolderBalance is one candidate holder and the balance the DISCOVERY source
// (the indexer's HolderList, in practice — see magi-indexer/creator_tokens_views.yaml) last
// reported for them. Advisory only: see Plan's doc for why a stale or wrong
// Balance here can cost a wasted transaction but can never cause an
// over-payment — the contract, not this struct, is the source of truth for
// what a holder is actually owed.
type HolderBalance struct {
	Holder  string
	Balance *big.Int
}

// MarketView is everything Plan needs to know about one creator's market: a
// snapshot assembled by the CALLER (cmd/keeper, in a real deployment: a
// direct chain read for Phase/Supply — SPEC §2.5 routes "status, supply,
// floor" through getStateByKeys, never through the indexer — and the
// indexer's HolderList for candidate Holders). This package takes the
// snapshot as given and performs no reading of its own; that is what makes
// Plan a pure function and this whole package testable with no network.
//
// Supply is carried for observability only. Plan's own decisions never
// branch on it, because the contract's own CloseIfDrained already performs
// the only check that matters, and performs it against LIVE state, not this
// snapshot: I3 (core/API.md) is `supply == Σ balances + credits currently
// escrowed`, so Supply can be strictly greater than zero here even after
// every holder in Holders has been fully refunded, whenever an ask is still
// open in escrow (SPEC §1.7.5: "In-flight asks are never cut off... the
// creator can still answer, the asker can still reclaim"). A caller building
// MarketView is not required to populate Supply at all for Plan to behave
// correctly; it exists so cmd/keeper's dry-run output (and any real
// operator's logs) can explain WHY a FROZEN market's CloseIfDrained op keeps
// coming back as a no-op instead of that looking like a bug.
// Retired mirrors core.RetiredAt: has this market been Retired, regardless of
// what Phase currently reads?
//
// DEFECT FIX 2026-07-28. Plan used to treat `Phase == StateFrozen` as
// synonymous with "wind-down is open", on the stated reasoning that "there is
// no separate on-chain WIND-DOWN state to check for". That is false.
// core.Phase() is MAX(naturalPhase, retiredPhase), and core's own inWindDown
// returns true from the RETIRE BLOCK onward — including the whole GraceBlocks
// notice window, during which Phase still reads OVERDUE. So a retired market
// is in wind-down and refundable while Plan, filtering on Frozen alone, saw
// nothing to do and returned zero ops for up to GraceBlocks.
//
// Harmless but real: no holder was ever stuck (Refund, the self-serve pull,
// is open the instant inWindDown is true, and any third party can push), so
// the cost was at most delayed convenience — exactly the package's own
// "at most delay, never harm" ceiling. It still contradicted the invariant
// Plan claimed to implement, which is why it is fixed rather than documented.
//
// A caller that cannot cheaply read this may leave it false: Plan then
// behaves exactly as it did before, i.e. it degrades to the old late-but-safe
// behaviour rather than to anything incorrect.
type MarketView struct {
	Creator string
	Phase   string // core.StateActive / StateOverdue / StateFrozen / StateClosed
	Retired bool   // core.RetiredAt(...) — see doc above
	Supply  *big.Int
	Holders []HolderBalance
}
