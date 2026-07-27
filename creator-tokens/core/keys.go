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
func kFrozenAt(c string) string     { return mk(c, "fz") }   // block the freeze took effect
func kRegisteredAt(c string) string { return mk(c, "reg") }  // block of registration
func kSeq(c string) string          { return mk(c, "seq") }  // escrow sequence counter

// ---- per-utility priced offers (access-credit utility, 2026-07-21) ----
//
// Unlock and Session are OPTIONAL, separately-priced creator offers, each with
// its own 2x/7d anti-rug band (SetUnlockPrice/SetSessionPrice, offer_price.go)
// mirroring kFace's own band keys (face/fsa/fan/faa). Unlike face, they are NOT
// posted at Register — they start UNSET (0), so a returning creator re-posts
// them fresh. New field tags, no collision with any existing tag
// (face/fsa/fan/faa/cap/sup/res/pu/st/fz/reg/seq/rat).
//
// ★ CORRECTED 2026-07-21: this comment used to assert that all of these "are
// cleared back to 0 on re-registration (Register, same H4 anti-rug reset the
// face anchor gets)". THAT WAS FALSE — Register cleared kObsIdx, kFaceAnchor
// and kFaceAnchorAt and nothing else, so a returning creator's unlock/session
// price and BAND ANCHOR both survived from the dead incarnation: the new
// market silently offered content at a price never posted in this life, and
// setBandedPrice measured the 2x/7d band against a defunct anchor (the exact
// H4 defect, one file over). Register now really does clear all EIGHT of
// these keys, so the claim is true as written — see market.go's
// per-incarnation reset block and its enumeration of what is deliberately
// NOT cleared.

func kUnlockPrice(c string) string         { return mk(c, "up") }   // unlock price, HBD base units
func kUnlockPriceSetAt(c string) string    { return mk(c, "upsa") } // block of last unlock-price change
func kUnlockPriceAnchor(c string) string   { return mk(c, "upa") }  // unlock price at the current band window's open
func kUnlockPriceAnchorAt(c string) string { return mk(c, "upaa") } // block the current unlock-price band window opened

func kSessionPrice(c string) string         { return mk(c, "sp") }   // session price, HBD base units
func kSessionPriceSetAt(c string) string    { return mk(c, "spsa") } // block of last session-price change
func kSessionPriceAnchor(c string) string   { return mk(c, "spa") }  // session price at the current band window's open
func kSessionPriceAnchorAt(c string) string { return mk(c, "spaa") } // block the current session-price band window opened

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

// ---- entitlements (spend-to-unlock, permanent) ----
//
// ent|<creator>|<buyer>|<postId> — set to "1" when `buyer` has permanently
// unlocked `postId` on `creator`'s market (Unlock, unlock.go). PERMANENT: never
// cleared, tied to the unlock EVENT not a live balance (Ruling 10 — selling all
// credits never revokes access). buyer and creator are validAccount (no '|');
// Unlock rejects a '|' in postId at the door, so the three-part key is
// unambiguous, exactly as kBal/kEscrow rely on the same '|'-free invariants.
func kEntitlement(c, buyer, postId string) string {
	return "ent|" + c + "|" + buyer + "|" + postId
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
// (face/fsa/fan/faa/cap/sup/res/pu/st/fz/reg/seq/rat/up/upsa/upa/upaa/sp/
// spsa/spa/spaa) or prefix (m|/bal|/e|/ent|/tw|).
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
// New prefix "twl|" — no collision with any existing prefix (m|/bal|/e|/ent|/
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
