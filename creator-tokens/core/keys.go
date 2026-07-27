package core

import "strconv"

// State key builders. State is already namespaced per-contract by the VSC store,
// so keys carry no contract-id prefix. Short keys to save write-gas (magi style).
//
// A "market" is identified by the creator's own Hive account name — the identity
// binding from SPEC §1.4 — so there is no separate market-id counter and
// impersonation is structurally impossible.

// ---- global ----

func kOwner() string    { return "owner" }    // platform owner (bound to contract.owner at init)
func kTreasury() string { return "treasury" } // where commission + subscription land
func kPaused() string   { return "paused" }   // global inbound pause (outflows never pause)

// ---- per-market config ----

func mk(c, field string) string { return "m|" + c + "|" + field }

func kFace(c string) string         { return mk(c, "face") } // ask price, HBD base units
func kFaceSetAt(c string) string    { return mk(c, "fsa") }  // block of last face change
func kFaceAnchor(c string) string   { return mk(c, "fan") }  // face at the current band window's open
func kFaceAnchorAt(c string) string { return mk(c, "faa") }  // block the current band window opened
func kCap(c string) string          { return mk(c, "cap") }  // max credits outstanding
func kSupply(c string) string       { return mk(c, "sup") }  // credits outstanding
func kReserve(c string) string      { return mk(c, "res") }  // HBD held for this market
func kPaidUntil(c string) string    { return mk(c, "pu") }   // subscription expiry, block height
func kState(c string) string        { return mk(c, "st") }   // MarketState
func kRegisteredAt(c string) string { return mk(c, "reg") }  // block of registration
func kSeq(c string) string          { return mk(c, "seq") }  // escrow sequence counter

// THERE IS NO kFrozenAt. `func kFrozenAt(c string) string { return mk(c,
// "fz") }` — "block the freeze took effect" — used to sit here. Nothing in
// this package ever wrote or read it: Phase (market.go) derives FROZEN
// LAZILY from kPaidUntil+GraceBlocks alone (API.md's rule — "never store the
// phase as truth"), so there is no freeze BLOCK to stamp; naturalPhase can
// always recompute it on demand. Two test fixtures (refund_test.go's
// forceFrozen, transfer_test.go's identical inline setup) wrote to it under
// the name "force the market into a ... FROZEN-shaped state," implying the
// write did something — it did not; both fixtures reach FROZEN purely via
// their own kPaidUntil write, at any query block >= paidUntil+GraceBlocks,
// exactly like every other FROZEN fixture in this package that never touched
// this key at all. DELETED per this file's own precedent (see keys.go's
// bonding-curve section above for the RULING A4/J/K deletions): an unused key
// builder, kept alongside a comment asserting a write that never happens, is
// the same class of defect as an unenforced exported constant — it reads as
// meaningful and is not. The tag "fz" is free; nothing is deployed, so no
// migration collision is possible (RetiredAt's kRetiredAt, which DOES need a
// real stamp because Retire is a discrete action at an arbitrary block, not
// derivable from paidUntil, is the actual analog this key was probably
// modelled on and never needed to be).

// ---- delivery standing (RULING E's delivery gate, built 2026-07-27) ----
//
// The subscription proves a creator is still THERE; these three keys prove
// they are still DELIVERING. Kept deliberately separate from the payment
// ladder (kPaidUntil/kState): payment and delivery are two independent facts
// about a creator, and folding them into one state string would make it
// impossible to say "paid up but not delivering" — which is exactly the
// creator this gate exists to catch. See delivery.go.
//
// Both counters are per ASSESSMENT WINDOW, not lifetime: crossing the
// threshold serves a penalty window and then resets them, so a creator can
// always climb back out. A lifetime counter would be a permanent sentence
// after three bad weeks in year one.
func kMissCount(c string) string       { return mk(c, "dmc") } // unanswered-past-deadline escrows this window
func kDeliveredCount(c string) string  { return mk(c, "ddc") } // answered + declined escrows this window
func kDelinquentUntil(c string) string { return mk(c, "ddu") } // block until which inflows are refused (0 = clear)

// ---- per-incarnation offering catalogue (N named priced offers, 2026-07-27) ----
//
// A creator posts up to MaxOfferings named services ("15-min call", "custom
// song"), each with its OWN HBD price under its OWN 2x/7d anti-rug band — the
// same setBandedPrice helper offer_price.go already uses, for the same reason
// (a buyer holding tokens to spend on a specific service is protected against a
// price spike on THAT service). Offering id 0 is RESERVED and never allocated:
// it denotes the legacy single `face` price, so Ask(offeringId=0) is the
// byte-for-byte audited face path and every existing test keeps its meaning.
//
// THE EPOCH, and why it exists. Every other per-incarnation key is cleared
// one-by-one in Register's reset block. That is impossible here: ids are
// MONOTONE (kOfferNext never rewinds, for kSeq's exact reason — an escrow
// records the id it was asked against, and a reused id would silently relabel a
// past incarnation's settlement history), so the live-id set is sparse and
// enumerating it would be O(next), an unbounded loop inside registration. The
// epoch is bumped by Register instead: every offering key of the dead
// incarnation becomes unreachable in ONE write, which is the same O(1) argument
// the kAcqBlock exception makes, without the enumeration. Nothing leaks across
// incarnations — not a price, not a band anchor, not a title.
//
// A LIVE escrow cannot straddle an epoch bump, so an escrow's offeringId always
// resolves in the current epoch: escrowed credits keep kSupply > 0, and
// CloseIfDrained refuses to close a market with supply outstanding, so a market
// cannot reach CLOSED (the precondition for re-registration) while any escrow
// is still PENDING. TestOfferings_LiveEscrowCannotStraddleEpoch pins this.
//
// Id 0 doubles as the counter slot (there is no offering 0), so the two
// per-market counters need no separate field tags and cannot collide with a
// real offering's keys.

func kOfferEpoch(c string) string { return mk(c, "oep") } // monotone offering-namespace epoch, bumped by Register

func mko(c string, epoch, id uint64, field string) string {
	return "m|" + c + "|o|" + strconv.FormatUint(epoch, 10) + "|" + strconv.FormatUint(id, 10) + "|" + field
}

func kOfferNext(c string, e uint64) string { return mko(c, e, 0, "next") } // next id to allocate (first is 1)

// kOfferIds holds the LIVE ids as a comma-separated list, at most MaxOfferings
// long. It exists so listing a creator's shop is a single bounded read instead
// of a scan over the monotone id space — ids are sparse after any churn, so
// "iterate 1..next" would be an unbounded loop on a read path. The list IS the
// live set (its length is the live count); there is no second counter to drift
// out of sync with it.
func kOfferIds(c string, e uint64) string { return mko(c, e, 0, "ids") }

func kOfferPrice(c string, e, id uint64) string    { return mko(c, e, id, "p") }   // HBD base units, 0 == deleted/unset
func kOfferAnchor(c string, e, id uint64) string   { return mko(c, e, id, "pa") }  // price at the band window's open
func kOfferAnchorAt(c string, e, id uint64) string { return mko(c, e, id, "paa") } // block the band window opened
func kOfferSetAt(c string, e, id uint64) string    { return mko(c, e, id, "psa") } // block of the last price change
func kOfferTitle(c string, e, id uint64) string    { return mko(c, e, id, "t") }   // display label, free-form

// kOfferTitleAnchor / kOfferTitleAnchorAt — DEFECT FIX (2026-07-27): the
// per-(creator, epoch, NORMALIZED-title) anti-rug anchor that survives an
// offering's id lifecycle. offerings.go's CreateOffering has the full
// argument; short version: ids are monotone (kOfferNext never rewinds) and
// DeleteOffering frees the id's own kOfferPrice/kOfferAnchor/kOfferAnchorAt,
// so an id-keyed anchor can never survive a delete+recreate of the SAME
// service — proven: create at 508, get correctly refused jumping straight to
// 10,000,000 on that id, delete it, recreate FRESH under the identical title
// at 10,000,000, and it succeeds, because a brand-new id always reads its own
// price key as 0 and takes setBandedPrice's initial-posting branch
// unconditionally. The anti-rug PURPOSE (protect a buyer holding tokens meant
// for a specific priced SERVICE) is about the title a buyer recognizes, not
// the ephemeral id naming it in the live-id list, so the anchor durable
// enough to matter has to be keyed by the title instead.
//
// Epoch-scoped exactly like every other offering key: bumpOfferEpoch
// (Register, called on every re-registration) makes every mko(...) key of a
// dead incarnation unreachable in ONE write, and this anchor rides that same
// reset for free — nothing extra to clear, and a returning creator correctly
// starts with a blank slate.
//
// Field tags "ta|" and "taa|" are chosen so the two can never collide with
// each other, or with the existing id=0 field tags ("next", "ids"), for ANY
// title text: "ta|"+X and "taa|"+Y differ at their 3rd byte ('|' vs 'a') no
// matter what X and Y are, and neither can equal a pipe-free literal like
// "next"/"ids" (those never contain '|'; these always do). The title itself
// can never contain '|' (validOfferTitle rejects it at the door), so
// "ta|"+normTitle round-trips unambiguously back to normTitle.
func kOfferTitleAnchor(c string, e uint64, normTitle string) string {
	return mko(c, e, 0, "ta|"+normTitle)
}
func kOfferTitleAnchorAt(c string, e uint64, normTitle string) string {
	return mko(c, e, 0, "taa|"+normTitle)
}

// kOfferTitlePrice / kOfferTitleSetAt — DEFECT 1/2/3 FIX (2026-07-27): the
// title's own persistent "cur" and "last changed" fields, completing the
// title-level mirror of setBandedPrice's full 4-key contract
// (price/anchor/anchorAt/setAt) alongside kOfferTitleAnchor/
// kOfferTitleAnchorAt above. Before this, the title level tracked ONLY the
// window-open reference (anchor/anchorAt) and every write that could move a
// title's EFFECTIVE price (CreateOffering, SetOfferingPrice, SetOfferingTitle)
// had its own bespoke, partial rule for when to trust or refresh it — which is
// exactly how a rename could skip the gate entirely (defect 1), how a
// following reprice could then unconditionally launder the id's own foreign
// anchor back onto the title (defect 2), and how an expired-but-nonzero title
// could be routed into a brand-new id's initial-posting branch with NO band
// at all (defect 3). With the title carrying its OWN full price state,
// offerings.go's applyTitleBandedPrice can call setBandedPrice ITSELF against
// these keys — the identical helper, the identical window math, ONE call
// site for every path that can change what a title effectively costs — so
// none of the three can diverge from it again.
//
// Field tags "tp|" and "tsa|" round-trip unambiguously exactly like "ta|"/
// "taa|" above: "tp|"+X differs from "ta|"+Y and "taa|"+Y at byte index 1
// ('p' vs 'a'), differs from "tsa|"+Y at byte index 1 ('p' vs 's'), and from
// "next"/"ids" at byte index 0; "tsa|"+X differs from "ta|"/"taa|"/"tp|" at
// byte index 1 ('s' vs 'a'/'a'/'p') and from "next"/"ids" at byte index 0.
func kOfferTitlePrice(c string, e uint64, normTitle string) string {
	return mko(c, e, 0, "tp|"+normTitle)
}
func kOfferTitleSetAt(c string, e uint64, normTitle string) string {
	return mko(c, e, 0, "tsa|"+normTitle)
}

// ---- balances ----

// bal|<creator>|<holder> — credits held.
func kBal(c, holder string) string { return "bal|" + c + "|" + holder }

// ---- escrow ----

// e|<creator>|<seq> — an escrowed ask. Fields are stored as one packed record by
// the ask module; the key builder lives here so the schema stays in one file.
func kEscrow(c string, seq uint64) string {
	return "e|" + c + "|" + strconv.FormatUint(seq, 10)
}

// ---- price observations (TWAP) ----

// tw|<creator>|<i> — ring buffer of price observations; tw|<creator>|n = write index.
func kObs(c string, i uint64) string { return "tw|" + c + "|" + strconv.FormatUint(i, 10) }
func kObsIdx(c string) string        { return "tw|" + c + "|n" }

// ---- bonding curve: hold clock + trade-fee accrual ----
// (WAVE A, RULINGS-2026-07-21; re-based by RULINGS-v2 RULINGS J, J1, and K)
//
// Added as a separate, clearly-marked block per API.md's foundation-file rule.
// New prefixes "acq|"/"fee|" — no collision with any existing tag
// (face/fsa/fan/faa/cap/sup/res/pu/st/fz/reg/seq/rat) or prefix (m|/bal|/e|/tw|).
//
// DELETED HERE (RULING A4): kHoldWeightSum ("hw"), the WA = Σ bal·wacq
// aggregate the withdrawn v1 RULING 1 wind-down needed. Any rule dividing an
// accumulated pot by a PURCHASABLE weight (bal, or bal·age) is drainable —
// v2's purchasable-weight lemma, measured at 97.5% of the pot to a 5-day
// attacker — and maintaining WA exactly at all balance-writing sites was
// itself the source of two test-proven live defects (an exit DoS and a
// partial write on a REJECTED sell — RULING G's exhibits).
//
// DELETED HERE (RULING J, 2026-07-21): the entire exit-tax pot key family —
// kAccIdx ("txi"), kTaxPot ("txp"), kIdxDebt ("txd|"), kClaimable ("txc|") —
// with its mechanism (taxpot.go, deleted). The holder distribution made the
// tax REGRESSIVE (effective rate ≈ τ·(1 − your share): a 1% fan paid 19.9%,
// a 99% whale 0.5%) and the whole patch family was refuted — even perfect
// snapshot + 7-day min-hold + seller exclusion left whale self-recovery at
// 97.5%, because an aged keeper account is indistinguishable from an honest
// holder. The tax now goes to kTreasury() (sell.go), which leaves NO
// accounting aggregate on any fund path — RULING G satisfied structurally.
// These four tags must never be reused for anything else: state written by a
// pre-J deployment could still carry them.
//
// DELETED HERE (RULING K, 2026-07-22): the cost-basis key kBasis ("bas|") AND
// the sell-episode accumulators kSaleProceeds ("spc|"), kSaleBasis ("sbc|"),
// kSaleTax ("stc|"). RULING K1 reverses J1's realized-gain cap: the exit tax
// is now GROSS proceeds × τ(h) at every value-out door (curve Sell AND
// wind-down Refund), with NO cap. A gross-proceeds tax is un-splittable by
// construction — proceeds are path-independent (curve.go L4) and ceil is
// superadditive (RULING F) — so two same-block sells pay AT LEAST the
// single-sell tax (the ET-1 chunk dodge that cost 67.62% under the per-sale
// cap is closed with ZERO per-holder state). With the cap gone there is no
// basis to track and no episode to net, so all four of these key families
// vanish. Net machinery is strictly LESS than the J1 design. These five tags
// ("bas|"/"spc|"/"sbc|"/"stc|", and the pre-J "txi/txp/txd/txc") must never
// be reused: a pre-K deployment's state could still carry them.

// kAcqBlock is the per-(creator,holder) weighted-average acquisition block —
// `wacq` in the rulings — the hold clock the exit-tax RATE keys on (KEPT by
// RULINGS A4 and J: the destination changed, the rate machinery never did).
// Stored as a u64 block height; ALL arithmetic on it happens in big.Int
// (bal·wacq ~ 1e9·1e10 = 1e19 > 2^64 — TinyGo u64 overflow is silent). Reset
// toward `now` on every inflow through creditInflow (holdclock.go) so a fresh
// or sybil account always looks maximally fresh. Unset (0) reads as "never
// clocked" and is treated as maximally FRESH, never as ancient — see
// holdclock.go's heldBlocksAt for why that direction is load-bearing.
func kAcqBlock(c, holder string) string { return "acq|" + c + "|" + holder }

// kFeeBal is the pull-claimable trade-fee balance per beneficiary account
// (RULING F8: the fee is NEVER pushed). The creator's 5% half of every trade
// fee accrues here; ClaimTradeFees (tradefee.go) zeroes it and returns the
// amount for the wrapper to transfer. The platform's half accrues to the
// existing kTreasury() pot, whose pull-exit is WithdrawTreasury (read.go) —
// one accrual key per beneficiary, both pull-based.
func kFeeBal(account string) string { return "fee|" + account }

// ---- long price observations (settlement, RULING C1) ----
//
// Added as a separate, clearly-marked block per API.md's foundation-file rule.
// New prefix "twl|" — no collision with any existing prefix (m|/bal|/e|/
// tw|/acq|/bas|/fee|): "twl|x" and "tw|x" differ at byte 3 because creator
// names can never contain '|' (validAccount), so the two families are
// disjoint for every creator.
//
// twl|<creator>|<i> — the LONG observation ring (32 slots, same packed
// "<block>|<rate>" format as tw|, same writer RecordObs) sampled at most once
// per LongObsSpacing blocks so the ring spans the ruled 7 days (RULING C1:
// TWAP_long = 7 days; params.go's LongObsSpacing doc has the storage-cost
// accounting). twl|<creator>|n = total observations ever written (a write
// counter, not a slot index — same convention as tw|<creator>|n).
//
// NOT reset by Register on re-registration (Register predates this family
// and resets kObsIdx only): askRateLong (twap.go) instead drops every sample
// older than kRegisteredAt at READ time, which closes the same
// cross-incarnation price-leak Register's kObsIdx reset closes for the short
// ring — see TestSettlement_LongRingDoesNotLeakAcrossReregistration.
func kObsLong(c string, i uint64) string { return "twl|" + c + "|" + strconv.FormatUint(i, 10) }
func kObsLongIdx(c string) string        { return "twl|" + c + "|n" }
