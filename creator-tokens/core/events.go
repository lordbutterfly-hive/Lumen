package core

import (
	"math/big"
	"strconv"
	"strings"
)

// events.go — pure event VALUE constructors (indexer/event-schema owner).
//
// Every function below is a pure string builder: no Store parameter, no I/O,
// no error return. A constructor cannot fail — it is meant to be called only
// AFTER the corresponding core.* call in this package already succeeded,
// using exactly the values that call validated and/or returned. The
// contract's wasm layer calls one of these after a successful action and
// passes the result straight to sdk.Log(...), unchanged.
//
// HARD RULES for this file (do not relax them):
//   - Pure value constructors only. No Store, no I/O, no error return.
//   - No imports beyond stdlib (math/big for amounts, strconv/strings for
//     encoding) — this file must never gain a dependency that could pull
//     wasm-incompatible code into the core package.
//   - Every event name is a permanent, append-only wire format: "type" + "v"
//     (schema version) are the discriminator pair. A future incompatible
//     change to one event's shape bumps that event's "v" and/or adds a new
//     field; it never repurposes an existing field name or silently removes
//     one a "v":1 consumer still depends on.
//   - Every identifier in this file is prefixed "ev" (exported constructors:
//     "Ev...") specifically so it cannot collide with a same-named
//     identifier another agent's file in this package independently
//     introduces — mirrors refund.go's own documented reason for the same
//     convention on parBaseUnitsPerCredit.
//
// WHY THIS FILE EXISTS: contract state (SPEC-CREATOR-KEYS.md §1.5) holds
// only the CURRENT escrow set and CURRENT balances — it has no memory of an
// ask that was already answered or reclaimed, no memory of what a creator's
// face price used to be, no memory of who held a credit before it was
// refunded away. The delivery record (SPEC §2.0.2, §2.1.A.2: "the primary
// number on screen ... cannot be gamed by posting frequency alone") is
// fundamentally a HISTORY, and a history only exists if every state
// transition is also logged as an append-only event. This file is the only
// place that history is created; ../indexer is the only place it is read
// back and folded into queryable aggregates.
//
// One event per fund/state-changing core.go entrypoint (plus Reclaim/Answer,
// which both resolve one escrow):
//
// ★ THIS TABLE IS THE ONLY PLACE THE WIRE SHAPES ARE WRITTEN DOWN, so a stale
// row here is an indexer built against a field that does not exist. It had gone
// stale twice by 2026-09-12: `prepaid` survived the deletion of prepay.go, and
// the three escrow rows still carried `commissionHbd` months after Ask stopped
// having an HBD leg. Both corrected below; if you change an Ev* builder, change
// its row in the same edit.
//
//	Register        -> {"type":"registered","v":1,"creator":"...","actor":"...","block":N,"face":"...","cap":"...","feePaid":"..."}
//	SetFace         -> {"type":"faceChanged","v":1,"creator":"...","actor":"...","block":N,"oldFace":"...","newFace":"..."}
//	SetCap          -> {"type":"capChanged","v":1,"creator":"...","actor":"...","block":N,"oldCap":"...","newCap":"..."}
//	TransferCredits -> {"type":"transferred","v":1,"creator":"...","actor":"...","to":"...","block":N,"amount":"..."}
//	Ask             -> {"type":"asked","v":1,"creator":"...","actor":"...","block":N,"seq":N,"creditsSpent":"...","commissionCredits":"...","rate":"...","deadlineBlocks":N,"contentHash":"...","offeringId":N}
//	Answer          -> {"type":"answered","v":1,"creator":"...","actor":"...","block":N,"seq":N,"creditsToCreator":"...","commissionCredits":"...","commissionTo":"...","answerHash":"..."}
//	Reclaim         -> {"type":"reclaimed","v":1,"creator":"...","actor":"...","block":N,"seq":N,"credits":"...","commissionRetainedCredits":"...","retainedTo":"...","asker":"..."}
//	Decline         -> {"type":"declined","v":1,"creator":"...","actor":"...","block":N,"seq":N,"credits":"...","asker":"..."}
//	Refund          -> {"type":"refunded","v":1,"creator":"...","actor":"...","block":N,"credits":"...","payout":"..."}
//	RefundHolder    -> {"type":"refundPushed","v":1,"creator":"...","actor":"...","holder":"...","block":N,"creditsBurned":"...","payout":"..."}
//	CloseIfDrained  -> {"type":"closed","v":1,"creator":"...","actor":"...","block":N}
//
// THERE IS NO `prepaid` ROW. core/prepay.go and the `prepay` entrypoint were
// deleted with the PAR mint (RULING A, RULINGS-v2-2026-07-21); nothing can emit
// one, so the builder went too (2026-09-12), the same call this file already
// made for EvRenewed when the subscription was removed. Historical `prepaid`
// rows in the indexer are untouched - they are chain history, and this file
// only ever WRITES events.
//
// Four fields every single event carries: "type"/"v" (the discriminator pair),
// "creator" (which market), "actor" (who initiated this state change —
// always present, even when it structurally always equals creator, e.g.
// registered/faceChanged/capChanged/answered, for a uniform shape across all
// twelve events an indexer folds identically). Two more carry a second
// identity when the state change moves value TO someone other than actor:
// "to" (transferred) and "holder" (refundPushed, where actor is the
// permissionless PUSHER and holder is who actually gets paid — never the
// same field, since RefundHolder can never pay the caller).
//
// KNOWN GAPS — core's own function signatures do not return everything a
// complete audit trail wants, so three fields below (oldFace, oldCap,
// creditsBurned) MUST be sourced by the CALLER (the wasm layer) from a
// Store read taken immediately BEFORE calling core.SetFace / core.SetCap /
// core.RefundHolder respectively — this file never touches Store and cannot
// originate them itself:
//   - core.SetFace/SetCap return only `error`, never the price/cap that was
//     just replaced. Without oldFace/oldCap, a face-change audit history
//     degenerates to "what is it now," not "what did it move from/to."
//   - core.RefundHolder returns only the HBD payout, never the credits
//     amount it burned — even though refund.go's own doc states it always
//     burns the holder's ENTIRE balance. Omitting creditsBurned here would
//     force the indexer to *infer* the burned amount from its own replayed
//     balance state rather than have the chain confirm it directly, which
//     is a foot-gun the first time that replay ever drifts from truth (a
//     missed event, a reorg, a bug). Recording it here for the caller to
//     fill in makes the audit log self-verifying instead.
//
// THIRD GAP, CLOSED — kept here as a corrected historical note rather than
// silently deleted, because the surrounding two gaps above are still open and
// a reader scanning this list needs to know this one no longer belongs with
// them. This used to say: "core.Answer's own AnswerResult ... returns only
// CreditsToCreator — never the commissionHbd ... RECOMMENDED FIX, out of this
// file's ownership to make: add a CommissionHbd *big.Int field to
// AnswerResult." That fix landed the same day (ask.go, 2026-07-21):
// AnswerResult now carries CommissionHbd directly, mirroring
// ReclaimResult.CommissionHbd's shape exactly, and the wasm wrapper's
// `answer` entrypoint reads it straight off the result (no Store pre-read
// needed, unlike oldFace/oldCap/creditsBurned above). Leaving the old
// "no clean source exists" claim in place after the field shipped would have
// sent the next reader hunting for a workaround to a problem that was already
// solved.
//
// INTEGRATION STATE, CORRECTED: this used to also claim "../contract's
// current main.go, as it stands, does NOT call any of the constructors in
// this file — it hand-builds its own sdk.Log JSON inline at each entrypoint
// ... Wiring main.go's twelve sdk.Log call sites to call Ev*(...) here
// instead is a small, mechanical follow-up ... not done here." That was true
// when this file was first written and has not been true for a while:
// contract/main.go's register/renew/setFace/setCap/transfer/ask/answer/
// decline/reclaim/refund/buy/sell/refundHolder/closeIfDrained/
// createOffering/setOfferingPrice/setOfferingTitle/deleteOffering
// entrypoints all call the corresponding core.Ev*(...) constructor in this
// file today. The oldFace/oldCap/creditsBurned pre-reads two gaps above
// describe are exactly what main.go's setFace/setCap/refundHolder
// entrypoints actually do, correctly, right before their core call.
//
// SIX MORE, CLOSED 2026-07-28 (a prior gap-hunt's own finding, left for an
// owner until now): main.go's init/pause/unpause/retire/withdrawTreasury/
// claimTradeFees entrypoints used to be the last holdouts hand-building their
// own sdk.Log JSON inline instead of calling a constructor here — see the
// "contract-level events" section below for the six new EvInit/EvPaused/
// EvUnpaused/EvRetired/EvTreasuryWithdrawn/EvTradeFeesClaimed constructors,
// now wired into every one of those six entrypoints.
// v6 (2026-09-22): token-denominated fields are decimal token strings (evTokens).
const evSchemaVersion = 2

// ---- shared encoding helpers -------------------------------------------

func evU64(v uint64) string { return strconv.FormatUint(v, 10) }
func evI64(v int64) string  { return strconv.FormatInt(v, 10) }

// evMoney renders a money amount as a base-10 string, "0" for nil — never a
// bare JSON number. Matches money.go's own convention ("No floats anywhere")
// extended to the wire format: a JS consumer's `number` silently loses
// precision above 2^53, and every amount in this system is meant to be read
// as an exact integer string end to end, chain to indexer to UI (see
// ../magi-indexer/creator_tokens_mappings.yaml, which keeps every amount field as `string` for the
// identical reason).
// evTokens writes a TOKEN amount as the decimal token string the wire carries
// (v6: state holds units, the wire holds tokens; money.go fmtTokens). The
// indexer sums these fields as numerics across the whole history, so a
// pre-v6 "2" and a v6 "1.50" add up correctly; emitting units would have
// corrupted every balance on the day of the update. HBD fields stay evMoney.
func evTokens(v *big.Int) string {
	return fmtTokens(v)
}

func evMoney(v *big.Int) string {
	if v == nil {
		return "0"
	}
	return v.String()
}

// evJSONEscape minimally escapes backslash and double-quote for embedding a
// value inside the hand-built JSON strings below. Not a general JSON string
// escaper — sufficient because every string field passed here is either a
// validAccount-charset account name (util.go: a-z0-9.- only, cannot contain
// '"' or '\') or a caller-supplied hash (ask.go's Ask/Answer already reject
// '|' in contentHash/answerHash at the door, but not '"' or '\' — those two
// must still be escaped here rather than assumed absent). Mirrors
// hive-price-market/contract/main.go's jsonEscape exactly.
func evJSONEscape(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '"' || c == '\\' {
			b.WriteByte('\\')
		}
		b.WriteByte(c)
	}
	return b.String()
}

// evOpen builds the shared envelope prefix common to all twelve events:
// {"type":"<name>","v":1,"creator":"<creator>","actor":"<actor>","block":<n>
// — deliberately with NO trailing comma and NO closing brace. Every
// constructor below appends its own event-specific fields (each prefixed
// with a leading comma) and closes the object itself. Centralizing this is
// what keeps all twelve constructors agreeing byte-for-byte on field order
// and quoting for the four fields every single event carries.
func evOpen(name, creator, actor string, block uint64) string {
	return `{"type":"` + name + `","v":` + evU64(evSchemaVersion) +
		`,"creator":"` + evJSONEscape(creator) + `"` +
		`,"actor":"` + evJSONEscape(actor) + `"` +
		`,"block":` + evU64(block)
}

// ---- event constructors -------------------------------------------------

// EvRegistered — Register (market.go, [AGENT 1]). actor is always ==
// creator (Register's own identity-binding guard: "caller must be the
// creator"), but the field stays named actor, not creator-twice, for a
// uniform shape across all twelve events. face/cap are Register's posted
// values (int64 in core's own signature, rendered here as a base-10 string
// like every other amount).
//
// feePaid is ALWAYS ZERO now, and that is not a placeholder — it is the
// whole point. REGISTRATION IS FREE (USER-RULED 2026-07-21, params.go):
// core.Register/registerCheck/registerApply take no fee parameter at all any
// more, and there is deliberately no RegistrationFee constant left to book
// "the full amount of" — see params.go's own deletion note. This doc used to
// say "feePaid is the exact amount Register's own caller proved paid (core
// books the full amount, not just the RegistrationFee floor)," which
// described a paid-registration mechanism that no longer exists anywhere in
// this package. The parameter is kept, always fed a literal 0 by the wasm
// wrapper (contract/main.go's `register` entrypoint), purely so this event's
// wire shape does not change out from under an existing indexer/consumer —
// removing the field would be the breaking change this file's own "append-
// only wire format" rule (above) forbids just as much as repurposing it
// would be.
func EvRegistered(creator, actor string, block uint64, face, cap int64, feePaid *big.Int) string {
	return evOpen("registered", creator, actor, block) +
		`,"face":"` + evI64(face) + `"` +
		`,"cap":"` + evTokens(big.NewInt(cap)) + `"` +
		`,"feePaid":"` + evMoney(feePaid) + `"}`
}

// THERE IS NO EvRenewed. It logged Renew (market.go) — periods and the HBD
// paid, by whoever paid it. The 10 HBD monthly subscription was removed whole
// on 2026-09-12 (OWNER RULING; see params.go), Renew went with it, and an event
// builder for a call that cannot happen is the same dead-surface defect this
// package deletes constants for. The `renewed` event type is retired: no new
// one can ever be emitted, and the indexer view that folded `paid` into its
// treasury total loses one of its three inputs (see EvAnswered below, which
// loses another).

// EvFaceChanged — SetFace (market.go). oldFace MUST be read by the caller
// (a Store.Get(kFace(creator)) via whatever accessor the wasm layer has)
// BEFORE invoking core.SetFace — core.SetFace's own signature returns only
// `error` and never the value it just replaced. See the file-level "KNOWN
// GAPS" note.
func EvFaceChanged(creator, actor string, block uint64, oldFace, newFace int64) string {
	return evOpen("faceChanged", creator, actor, block) +
		`,"oldFace":"` + evI64(oldFace) + `"` +
		`,"newFace":"` + evI64(newFace) + `"}`
}

// EvCapChanged — SetCap (market.go). oldCap has the identical caller-must-
// pre-read requirement as EvFaceChanged's oldFace; see the file-level
// "KNOWN GAPS" note.
func EvCapChanged(creator, actor string, block uint64, oldCap, newCap int64) string {
	return evOpen("capChanged", creator, actor, block) +
		`,"oldCap":"` + evTokens(big.NewInt(oldCap)) + `"` +
		`,"newCap":"` + evTokens(big.NewInt(newCap)) + `"}`
}

// EvTransferred — TransferCredits (prepay.go). actor is the sender (`from`
// in TransferCredits' own signature); `to` is the receiving holder. Note
// core.TransferCredits itself takes no `caller` parameter at all and
// performs no authorization check of its own — the wasm layer is the ONLY
// enforcement boundary for "you can only move your own credits" (this is
// documented, load-bearing behaviour, not an oversight — see API.md's
// prepay.go section). actor here should always be whatever the wasm layer
// bound to TransferCredits' `from` argument.
func EvTransferred(creator, actor, to string, block uint64, amount *big.Int) string {
	return evOpen("transferred", creator, actor, block) +
		`,"to":"` + evJSONEscape(to) + `"` +
		`,"amount":"` + evTokens(amount) + `"}`
}

// EvAsked — Ask (ask.go, [AGENT 3]). actor is the asker. seq is the escrow
// sequence AskResult.Seq — the join key EvAnswered/EvReclaimed use to
// resolve this same escrow later. rate is the TWAP-derived settlement rate
// the wasm layer bound to core.Ask's own `rate` parameter (core.Ask
// performs no oracle read itself — see ask.go's file doc — so the caller
// always has this value already, from its own core.AskRate call
// immediately prior); carrying it lets an auditor verify
// creditsSpent == ceil(face/rate) after the fact without a chain read, and
// shows the effective price actually paid at that block, which
// creditsSpent alone does not (two asks can spend the same credits at two
// different rates if face also changed between them).
// offeringID identifies WHICH service this ask bought (0 == the legacy single
// face price). Added 2026-07-27: the indexer's own doc already claimed `asked`
// carried it — "so a settlement can be attributed to the service that was
// bought without joining on anything" — but the field did not exist, so no
// consumer could tell a $25 call from a $200 song, or check that a settlement
// used the price that was posted at the time. State has no memory of a
// resolved ask (ask.go), so if this event omits it the attribution is gone for
// good.
// ★ commissionCredits REPLACED commissionHbd (OWNER RULING 2026-09-12). The
// commission is 12% OF creditsSpent, in the creator's own token, not a separate
// HBD leg the buyer also paid — so `creditsSpent` is now the whole of what left
// the buyer and this field is a PARTITION of it, never an addition to it. An
// indexer that adds the two together double-counts the platform's slice. The
// KEY was renamed rather than reused precisely so a consumer written against
// the old shape fails loudly instead of quietly summing the wrong model.
func EvAsked(creator, actor string, block, seq uint64, creditsSpent, commissionCredits, rate *big.Int, deadlineBlocks uint64, contentHash string, offeringID uint64) string {
	return evOpen("asked", creator, actor, block) +
		`,"seq":` + evU64(seq) +
		`,"creditsSpent":"` + evTokens(creditsSpent) + `"` +
		`,"commissionCredits":"` + evTokens(commissionCredits) + `"` +
		`,"rate":"` + evMoney(rate) + `"` +
		`,"deadlineBlocks":` + evU64(deadlineBlocks) +
		`,"offeringId":` + evU64(offeringID) +
		`,"contentHash":"` + evJSONEscape(contentHash) + `"}`
}

// EvAnswered — Answer (ask.go). actor is always == creator (Answer is
// creator-only), kept as actor for the same uniform-shape reason as
// EvRegistered. seq matches the EvAsked this event resolves.
//
// commissionHbd (M4 fix, 2026-07-21 — PRUNED-ADJUDICATION-2026-07-21.md) was
// the HBD commission Answer booked to kTreasury() in the very same call that
// produced this event. It existed so the indexer could cross-check kTreasury()
// (SPEC §1.7.3, "where commission + subscription land") against an indexer
// aggregate that folded it together with EvRegistered's feePaid and
// EvRenewed's paid.
//
// ALL THREE OF THOSE INPUTS ARE NOW GONE OR ZERO: registration is free
// (RegistrationFee deleted 2026-07-21), Renew no longer exists (2026-09-12) and
// the commission is tokens (2026-09-12). kTreasury() itself is NOT dead — it
// still accrues the platform half of every trade fee (tradefee.go) and the
// platform half of every exit tax (exittax.go), both of which carry their own
// events.
//
// ★ AND THERE IS NO `Index.TreasuryHbd` TO REBUILD (checked 2026-09-12). Three
// comments in this repo, and one line of the deploy runbook, sent a reader to
// "creator_tokens_views.yaml's Index.TreasuryHbd". That view does not exist and
// on the evidence never did: the file defines exactly six views —
// lumen_ct_balances, _price_history, _delivery_record, _my_asks,
// _creator_earnings, _discovery — and none of them sums an HBD treasury. So
// nothing is currently reporting a wrong treasury figure, and nothing needs
// fixing before this deploy. If a platform-revenue view is ever wanted, its
// inputs are the two event streams named above, never these three.
//
// ★ commissionCredits AND commissionTo REPLACED commissionHbd (OWNER RULING
// 2026-09-12). The commission is now 12% of the escrow's TOKENS credited to the
// platform owner's position on this market, so the event has to name both the
// amount and the ACCOUNT: an indexer folding it into a global treasury total,
// as the old HBD field's doc instructed, would show tokens nobody holds while
// the owner's real balance moved with no event behind it. creditsToCreator and
// commissionCredits are the two halves of the escrow and sum to exactly it.
// commissionTo is "" when no owner was bound, in which case commissionCredits
// is zero and the creator received the whole escrow.
func EvAnswered(creator, actor string, block, seq uint64, creditsToCreator, commissionCredits *big.Int, commissionTo, answerHash string) string {
	return evOpen("answered", creator, actor, block) +
		`,"seq":` + evU64(seq) +
		`,"creditsToCreator":"` + evTokens(creditsToCreator) + `"` +
		`,"commissionCredits":"` + evTokens(commissionCredits) + `"` +
		`,"commissionTo":"` + evJSONEscape(commissionTo) + `"` +
		`,"answerHash":"` + evJSONEscape(answerHash) + `"}`
}

// EvReclaimed — Reclaim (ask.go). actor is the CALLER who triggered this
// reclaim — NOT necessarily the escrow's asker. (This doc used to claim
// "actor is always == the escrow's own stored asker (Reclaim's own auth
// check: 'caller != rec.asker' is rejected)"; that described a guard Reclaim
// no longer has, and never has since the H1 defect fix, 2026-07-21, made
// Reclaim permissionless — see the very next paragraph, which was added at
// the same time and already says so. asker below, not actor, is who was
// actually paid.) seq matches the EvAsked this event resolves.
//
// commissionHbd (M4 fix, 2026-07-21 — PRUNED-ADJUDICATION-2026-07-21.md;
// supersedes this doc's own former "No commission leg" claim, which
// conflated two different things): I5 ("no commission on refunds") means
// the asker is never CHARGED a commission on reclaim — it does NOT mean no
// HBD moves. The commission was HELD in the escrow at Ask time (never
// booked to treasury), and Reclaim hands that exact amount back to the
// asker in full (core.ReclaimResult.CommissionHbd, ask.go — core.Reclaim
// already returns this today; it was simply never logged). That is a REAL
// HBD outflow the old event shape made invisible: the credits leg was
// logged, the HBD leg was not, so a replay could never reconcile what
// Reclaim actually paid out. See ../magi-indexer/creator_tokens_views.yaml's
// Index.ReclaimOutflowHbd, which folds this field into a GLOBAL running
// total of every commission HBD unit ever handed back this way.
// asker (added 2026-07-27) is WHO WAS ACTUALLY PAID, and it is not optional.
// Reclaim is permissionless (H1): `actor` is whoever submitted the transaction,
// which may be a keeper or any passing stranger pushing an abandoned escrow,
// while the credits and the commission always go to the escrow's own asker. An
// indexer folding `actor` as the recipient credits the wrong account every time
// a third party reclaims — and it cannot recover the right one from its own
// escrow map either, since an index that started mid-stream never saw the Ask.
// commissionRetainedCredits (USER RULING 1, 2026-07-28; re-denominated from HBD
// to tokens by the OWNER RULING 2026-09-12) is the slice the protocol KEPT
// because this reclaim was a miss, and `credits` is the NET the asker actually
// got back. The two must be carried separately or a replaying indexer cannot
// balance the books — together they are the whole escrow. retainedTo names the
// account credited with the slice, for the same reason EvAnswered's commissionTo
// exists: the slice is tokens on a real account now, not a global HBD bucket.
// Both are zero/"" on a self-dealt escrow (not a miss).
func EvReclaimed(creator, actor string, block, seq uint64, credits, commissionRetainedCredits *big.Int, retainedTo, asker string) string {
	return evOpen("reclaimed", creator, actor, block) +
		`,"seq":` + evU64(seq) +
		`,"credits":"` + evTokens(credits) + `"` +
		`,"commissionRetainedCredits":"` + evTokens(commissionRetainedCredits) + `"` +
		`,"retainedTo":"` + evJSONEscape(retainedTo) + `"` +
		`,"asker":"` + evJSONEscape(asker) + `"}`
}

// EvRated — Rate (rating.go, USER RULING 2026-07-28). The buyer's score for a
// DELIVERED job, and the only counterweight to `Answer` being a unilateral
// "this is done" that pays the creator. Carries no money and touches no fund
// path: it is reputation, and reputation must never gate a payout.
//
// `actor` is the BUYER (rating.go refuses anyone else), which is why there is
// no separate asker field here as there is on reclaimed/declined — on this
// event the actor IS the payer, always.
func EvRated(creator, actor string, block, seq, score uint64) string {
	return evOpen("rated", creator, actor, block) +
		`,"seq":` + evU64(seq) +
		`,"score":` + evU64(score) + `}`
}

// EvDeclined — Decline (ask.go, RULING E's delivery gate, 2026-07-27). Same
// money shape as EvReclaimed except that NOTHING is ever retained, so `credits`
// is always the whole escrow going back to the asker but a DIFFERENT event, deliberately: a reclaim means the creator went
// silent until the window closed, a decline means they answered promptly with
// "no". Only one of those is a black mark, and an indexer that could not tell
// them apart would show a conscientious creator the same delivery record as an
// absent one. actor is always == creator (Decline is creator-only).
func EvDeclined(creator, actor string, block, seq uint64, credits *big.Int, asker string) string {
	return evOpen("declined", creator, actor, block) +
		`,"seq":` + evU64(seq) +
		`,"credits":"` + evTokens(credits) + `"` +
		`,"asker":"` + evJSONEscape(asker) + `"}`
}

// EvRefunded — Refund (refund.go, [AGENT 4]). actor pulls their OWN refund
// (API.md rule 2: pull-based) — there is no separate recipient field
// because Refund can only ever pay actor. credits is the amount actor
// chose to burn (Refund's own `credits` argument); payout is the HBD they
// received for it (Refund's return value), which can be strictly less than
// `credits` whenever RefundPrice < PAR (I2).
func EvRefunded(creator, actor string, block uint64, credits, payout *big.Int) string {
	return evOpen("refunded", creator, actor, block) +
		`,"credits":"` + evTokens(credits) + `"` +
		`,"payout":"` + evMoney(payout) + `"}`
}

// EvBought — Buy (buy.go), WAVE D. actor is the buyer (== whom the tokens are
// minted to and who pays totalDue). minted == the tokens argument; cost is the
// exact curve leg that entered kReserve; fee is the total trade fee accrued to
// the pull pots (never the reserve, C-19); totalDue == cost+fee, the wrapper's
// single HiveDraw from the buyer.
func EvBought(creator, actor string, block uint64, minted, cost, fee, totalDue *big.Int) string {
	return evOpen("bought", creator, actor, block) +
		`,"minted":"` + evTokens(minted) + `"` +
		`,"cost":"` + evMoney(cost) + `"` +
		`,"fee":"` + evMoney(fee) + `"` +
		`,"totalDue":"` + evMoney(totalDue) + `"}`
}

// EvSold — Sell (sell.go), WAVE D. actor is the seller. sold == the tokens
// argument (ΔS); gross is the exact reserve debit (the curve slice); tax is
// the exit tax carved to the treasury (RULING J/K, gross×τ, no cap); fee is
// the trade fee to the pull pots; net == gross−tax−fee, the seller's single
// payout; taxBps/heldBlocks are the exit-tax rate actually applied and the
// hold clock it was read from.
//
// WHERE `tax` ACTUALLY GOES, because a consumer cannot see it from this event
// and getting it wrong silently corrupts a solvency total: accrueExitTax
// (exittax.go) SPLITS it — floor(tax/2) to the seller's creator's
// pull-claimable kFeeBal, the REMAINDER to the global kTreasury(). It is one
// rule for every seller; the `seller == creator` special case was deleted
// (USER RULING 2026-07-28). A consumer folding the whole `tax` into a treasury
// total therefore OVERSTATES it by every creator-half ever split off — which
// is exactly what the indexer did until this was written down. The two halves
// are not emitted separately because they are derivable from `tax` alone, and
// duplicating them would create a second source of truth to drift.
func EvSold(creator, actor string, block uint64, sold, gross, tax, fee, net, taxableGross *big.Int, taxBps, heldBlocks uint64) string {
	return evOpen("sold", creator, actor, block) +
		`,"sold":"` + evTokens(sold) + `"` +
		`,"gross":"` + evMoney(gross) + `"` +
		`,"tax":"` + evMoney(tax) + `"` +
		`,"fee":"` + evMoney(fee) + `"` +
		`,"net":"` + evMoney(net) + `"` +
		`,"taxBps":` + evU64(taxBps) +
		`,"heldBlocks":` + evU64(heldBlocks) +
		// taxableGross is the MATURING share of the gross — the base the rate
		// was actually charged on (2026-07-30). APPEND-ONLY, at the end, per
		// this file's wire rule. Without it no consumer can reproduce the tax
		// from the event: `gross × taxBps` overstates it for any position that
		// is part-matured, by up to the whole 20%.
		`,"taxableGross":"` + evMoney(taxableGross) + `"}`
}

// EvRefundPushed — RefundHolder (refund.go). actor is the PERMISSIONLESS
// PUSHER/keeper — never the payout recipient (API.md rule 2's one
// exception: "may be pushed by anyone but only ever pays the holder").
// holder is who is actually paid. creditsBurned MUST be read by the caller
// (a Store.Get of the holder's balance) immediately BEFORE invoking
// core.RefundHolder — core.RefundHolder's own return value is only the HBD
// payout, even though refund.go's own doc guarantees it always burns the
// holder's ENTIRE balance. See the file-level "KNOWN GAPS" note for why
// this is worth the extra read rather than leaving creditsBurned inferred.
func EvRefundPushed(creator, actor, holder string, block uint64, creditsBurned, payout *big.Int) string {
	return evOpen("refundPushed", creator, actor, block) +
		`,"holder":"` + evJSONEscape(holder) + `"` +
		`,"creditsBurned":"` + evTokens(creditsBurned) + `"` +
		`,"payout":"` + evMoney(payout) + `"}`
}

// EvClosed — CloseIfDrained (refund.go). core.CloseIfDrained itself takes
// NO caller parameter at all (it is fully permissionless — "core has no
// Init/Owner concept," and this action needs no auth either), so actor here
// may legitimately be "" if the wasm layer has no caller identity to bind
// at this entrypoint (e.g. a scheduled/keeper sweep with no per-call
// signer semantics worth recording) — callers that DO have one (a signed
// transaction invoking this action) should still pass it, purely for audit
// ("who happened to trigger this"), never for authorization.
//
// core.CloseIfDrained is documented IDEMPOTENT: it returns true both the
// first time a market transitions to CLOSED and on every subsequent call
// against an already-CLOSED market. This constructor does not guard
// against being called on a no-op transition — that is the wasm layer's
// job (e.g. only log when CloseIfDrained's return value flips from a
// previously-observed non-closed read, or simply accept that a duplicate
// "closed" event may appear and rely on the indexer treating it as a
// no-op, which ../indexer's Index does).
func EvClosed(creator, actor string, block uint64) string {
	return evOpen("closed", creator, actor, block) + `}`
}

// ---- offering catalogue (2026-07-27) -------------------------------------
//
// Three more events, taking the set from twelve to fifteen. They carry NO
// money: an offering is a posted price, and no HBD or token moves when one is
// created, repriced or withdrawn — the money events (asked/answered/reclaimed)
// already cover every fund flow an offering can lead to, and `asked` now
// carries the offeringId so an indexer can attribute a settlement to the
// service that was bought without joining on anything.
//
// The creator is always the actor (all three are creator-only, active-auth
// gated), so evOpen's creator/actor pair is deliberately the same account here
// rather than a distinct signer — same shape as faceChanged/capChanged.

// EvOfferingCreated — CreateOffering (offerings.go).
func EvOfferingCreated(creator, actor string, block, id uint64, title string, price *big.Int) string {
	return evOpen("offeringCreated", creator, actor, block) +
		`,"offeringId":` + evU64(id) +
		`,"title":"` + evJSONEscape(title) + `"` +
		`,"price":"` + evMoney(price) + `"}`
}

// EvOfferingUpdated — SetOfferingPrice / SetOfferingTitle. Carries both the
// title and the price either side of the change, so an indexer folds one shape
// for both edits and diffs to see which moved.
func EvOfferingUpdated(creator, actor string, block, id uint64, title string, oldPrice, newPrice *big.Int) string {
	return evOpen("offeringUpdated", creator, actor, block) +
		`,"offeringId":` + evU64(id) +
		`,"title":"` + evJSONEscape(title) + `"` +
		`,"oldPrice":"` + evMoney(oldPrice) + `"` +
		`,"newPrice":"` + evMoney(newPrice) + `"}`
}

// EvOfferingDeleted — DeleteOffering. The offering leaves the shop; escrows
// already opened against this id are untouched and settle normally.
func EvOfferingDeleted(creator, actor string, block, id uint64) string {
	return evOpen("offeringDeleted", creator, actor, block) +
		`,"offeringId":` + evU64(id) + `}`
}

// ---- contract-level events (2026-07-28, gap-hunt closure) ----------------
//
// Six more constructors for six contract/main.go entrypoints (init, pause,
// unpause, retire, withdrawTreasury, claimTradeFees) that used to hand-build
// their own sdk.Log(...) JSON inline with no constructor behind any of them —
// a prior gap-hunt's own finding, left for an owner until now. Three of the
// six (retired, treasuryWithdrawn, tradeFeesClaimed) are real, fund- or
// state-relevant events ../magi-indexer/creator_tokens_mappings.yaml ALREADY has typed decode structs
// for (RetiredEvent, TreasuryWithdrawnEvent, TradeFeesClaimedEvent — read
// directly before writing any of this); a hand-built line could silently
// drift out of sync with those structs with nothing to catch it. The other
// three (init, paused, unpaused) have no indexer decode struct at all —
// ../magi-indexer/creator_tokens_mappings.yaml's own file doc names them DELIBERATELY unrecognized
// (init is not a core-module event; the global pause switch has no query
// surface in that package) — so they exist here purely so this package's own
// schema-pin tests can lock their shape down, not to feed a consumer.
//
// TWO envelope shapes below, not one, because these six do not all share the
// per-market shape every event above this section uses:
//
//   - EvRetired fits the shared envelope above exactly (creator/actor/block)
//     — Retire is an ordinary per-market action — and matches
//     RetiredEvent{Creator,Actor,Block} field for field.
//   - The other five are NOT per-market. init/pause/unpause are global
//     contract-level actions with no creator at all; withdrawTreasury debits
//     the one GLOBAL kTreasury() pot; claimTradeFees pays out kFeeBal(caller)
//     — keyed by the CALLER, never by a separate creator argument (indexer's
//     own doc: "Actor here doubles as the creator identifier"). Routing these
//     through the shared four-field envelope would force a "creator" key onto
//     a shape that never had one — for treasuryWithdrawn and tradeFeesClaimed
//     specifically that would be a real deviation from the wire shape
//     magi-indexer/creator_tokens_mappings.yaml's own structs already commit to (both declare
//     Actor/Block/Amount ONLY; that package's own doc calls the omission on
//     both deliberate). An extra ignored JSON key would not literally break
//     decoding — encoding/json silently drops unrecognized fields — but it
//     would contradict a design decision recorded in a file this package
//     cannot edit, for no benefit, so these five use the actor-only envelope
//     below instead. Every one of the six below renders BYTE-IDENTICAL JSON
//     (same fields, same order) to the hand-built line it replaces — this is
//     a pure refactor of the STRING BUILDER, not a wire-format change.

// evOpenActor is the sibling of evOpen for events with NO creator concept: an
// object opened with just "ev"/"v"/"actor" — same no-trailing-comma,
// no-closing-brace convention, so callers append their own event-specific
// fields (each prefixed with a leading comma) and close the object
// themselves.
func evOpenActor(name, actor string) string {
	return `{"type":"` + name + `","v":` + evU64(evSchemaVersion) +
		`,"actor":"` + evJSONEscape(actor) + `"`
}

// EvRetired — Retire (market.go). Wire shape matches magi-indexer/creator_tokens_mappings.yaml's
// RetiredEvent{Creator,Actor,Block} exactly (verified by direct read); no
// money, no extra fields.
func EvRetired(creator, actor string, block uint64) string {
	return evOpen("retired", creator, actor, block) + `}`
}

// EvInit — the wasm wrapper's one-time owner-bootstrap log (contract/main.go's
// `init` entrypoint). core has no Init/Owner concept of its own — kOwner() is
// a documented key builder nothing in this package ever reads or writes — so
// this event exists purely to give that log a typed, pinned constructor,
// never to introduce a concept core doesn't otherwise have. The field is
// named "owner", not "actor": this is the exact key the hand-built log it
// replaces already used (contract/main.go's Init requires caller ==
// contract.owner before this is ever reached, so the two names would carry an
// identical value regardless) — kept rather than renamed for uniformity with
// every other event in this file, because nothing decodes this event today
// (../magi-indexer/creator_tokens_mappings.yaml's own file doc names "init" as deliberately
// unrecognized) and a cosmetic rename has no consumer to benefit from it,
// only a wire-format change to justify for nothing.
func EvInit(owner string) string {
	return `{"type":"init","v":` + evU64(evSchemaVersion) +
		`,"owner":"` + evJSONEscape(owner) + `"}`
}

// EvPaused / EvUnpaused — the wasm wrapper's owner-only global-pause toggle
// (contract/main.go's `pause`/`unpause` entrypoints). Actor-only, matching
// the hand-built logs they replace exactly (field set unchanged: "actor"
// only, no block, no creator — see ../magi-indexer/creator_tokens_mappings.yaml's own file doc for
// why the global pause switch has no per-market scope to carry).
func EvPaused(actor string) string {
	return evOpenActor("paused", actor) + `}`
}

func EvUnpaused(actor string) string {
	return evOpenActor("unpaused", actor) + `}`
}

// EvOwnerTransferInitiated / EvOwnerChanged — F19 DEFECT FIX (2026-08-19):
// the wasm wrapper's owner-rotation pair (contract/main.go's `changeOwner`/
// `acceptOwnership` entrypoints), added because the platform owner used to be
// bound write-once at Init with NO path to move it — a lost or compromised
// owner key permanently locked withdrawTreasury and pause/unpause, both
// unrecoverable. Two-step, mirroring magi-market's changeOwner/
// acceptOwnership pattern (magi-market/contract/market.go:787): a 1-step
// rotation to a typo'd account would be an instant permanent lockout, the
// exact bug this closes, pointed the other way.
//
// NOT indexer-recognized events, same precedent as EvInit/EvPaused/EvUnpaused
// above: core has no owner-rotation concept of its own (kOwner()/
// kPendingOwner() are documented key builders core itself never reads or
// writes), so these exist purely to give the wrapper's logs typed, pinned
// constructors instead of a hand-built sdk.Log no test can catch drifting.
func EvOwnerTransferInitiated(currentOwner, pendingOwner string) string {
	return `{"type":"ownerTransferInitiated","v":` + evU64(evSchemaVersion) +
		`,"currentOwner":"` + evJSONEscape(currentOwner) + `"` +
		`,"pendingOwner":"` + evJSONEscape(pendingOwner) + `"}`
}

func EvOwnerChanged(previousOwner, newOwner string) string {
	return `{"type":"ownerChanged","v":` + evU64(evSchemaVersion) +
		`,"previousOwner":"` + evJSONEscape(previousOwner) + `"` +
		`,"newOwner":"` + evJSONEscape(newOwner) + `"}`
}

// EvTreasuryWithdrawn — WithdrawTreasury (read.go). Wire shape matches
// magi-indexer/creator_tokens_mappings.yaml's TreasuryWithdrawnEvent{Actor,Block,Amount} exactly
// (verified by direct read of that struct and its own doc: "Deliberately no
// creator field... a GLOBAL kTreasury() debit, not scoped to any single
// creator's market"). actor is the contract owner (WithdrawTreasury's own
// caller==Owner guard); amount is exactly what core debited — WithdrawTreasury
// returns the same value it validated and subtracted, never a caller-supplied
// figure the wasm wrapper might otherwise have trusted instead.
func EvTreasuryWithdrawn(actor string, block uint64, amount *big.Int) string {
	return evOpenActor("treasuryWithdrawn", actor) +
		`,"amount":"` + evMoney(amount) + `"` +
		`,"block":` + evU64(block) + `}`
}

// EvTradeFeesClaimed — ClaimTradeFees (tradefee.go). Wire shape matches
// magi-indexer/creator_tokens_mappings.yaml's TradeFeesClaimedEvent{Actor,Block,Amount} exactly
// (verified by direct read: "No creator field on the wire either, but...
// Actor here doubles as the creator identifier" — kFeeBal is always keyed by
// the creator whose market accrued the fee, and ClaimTradeFees only ever pays
// out the CALLER's own balance, so actor and that creator are always the same
// account). amount is exactly what core debited from kFeeBal(actor).
func EvTradeFeesClaimed(actor string, block uint64, amount *big.Int) string {
	return evOpenActor("tradeFeesClaimed", actor) +
		`,"amount":"` + evMoney(amount) + `"` +
		`,"block":` + evU64(block) + `}`
}

// ---------------------------------------------------------------------------
// THE STANDARD (magi_nft-family) EVENTS — 2026-07-30, milestone M3.
//
// These are NOT our wire format. They are magi_nft's, byte for byte, because
// the Magi indexer discovers a token contract by watching for one specific
// event name and then folds its standard events into SHARED tables that every
// wallet and explorer already reads.
//
// ★ WITHOUT init_magi_nft THERE IS NO REGISTRY ROW, AND WITHOUT A REGISTRY ROW
// EVERY DOWNSTREAM VIEW IS EMPTY — not wrong, EMPTY. Balances, transfers, token
// info and the collection overview all filter on that registry. So this event is
// the load-bearing one, and it is why the core dev's remark about the init
// schema was not a nicety.
//
// TWO SHAPES COEXIST ON THIS CONTRACT. Our own eighteen curve events stay flat
// (`{"type":"bought","v":1,...}`); these nest under `attributes` as the standard
// does. The indexer matches on the top-level `type` alone and our names are
// disjoint from theirs, so both families index side by side with no collision.
//
// The DERIVED balance views compute holdings as inflow minus outflow over these
// events, so EVERY change to the matured bucket must emit one or the balance is
// permanently wrong for that holder. Mint shape is from:"", burn shape is to:"".

// EvInitMagiNft — emitted ONCE at contract init. The discovery trigger.
func EvInitMagiNft(owner, name, symbol string) string {
	return `{"type":"init_magi_nft","attributes":{"owner":"` + evJSONEscape(owner) +
		`","name":"` + evJSONEscape(name) +
		`","symbol":"` + evJSONEscape(symbol) +
		`","baseUri":""}}`
}

// EvTokenCreated — emitted when a creator registers, declaring their token id.
// maxSupply carries the market's cap; soulbound is always false (these tokens
// are transferable once matured — that is the whole point).
func EvTokenCreated(tokenID string, maxSupply uint64) string {
	return `{"type":"tokenCreated","attributes":{"tokenId":"` + evJSONEscape(tokenID) +
		`","maxSupply":` + evU64(maxSupply) +
		`,"soulbound":false}}`
}

// EvTransferSingle — every matured-bucket movement.
//
// `value` is a BARE NUMBER, matching the standard, and it is a token COUNT —
// never HBD. from=="" is a mint (a graduation into the tradable bucket),
// to=="" is a burn (a curve sale of matured tokens).
func EvTransferSingle(operator, from, to, tokenID string, value *big.Int) string {
	return `{"type":"TransferSingle","attributes":{"operator":"` + evJSONEscape(operator) +
		`","from":"` + evJSONEscape(from) +
		`","to":"` + evJSONEscape(to) +
		`","id":"` + evJSONEscape(tokenID) +
		`","value":` + value.String() + `}}`
}

// EvApproved — the ERC-6909 Approval event (F-C2): `owner` set `spender`'s allowance
// for token `id` to `amount`. The allowance model is DELIBERATELY the standard
// ERC-6909 one — persistent, not revoked-on-transfer — and that design is unchanged;
// this event is the standard's own answer to the survives-a-transfer footgun, making a
// live allowance OBSERVABLE so it can be revoked (Approve amount=0) with visibility. It
// carries the same `{type,attributes}` shape the indexer already folds for
// TransferSingle, so the door auto-recognises without a bespoke mapping. `amount` is a
// bare number — a token COUNT, never HBD.
func EvApproved(owner, spender, tokenID string, amount *big.Int) string {
	return `{"type":"Approval","attributes":{"owner":"` + evJSONEscape(owner) +
		`","spender":"` + evJSONEscape(spender) +
		`","id":"` + evJSONEscape(tokenID) +
		`","amount":` + amount.String() + `}}`
}

// EvMaturedMoved — the FLAT sibling of TransferSingle, for our own tables.
//
// Every matured-bucket movement emits BOTH: the standard TransferSingle (which
// the indexer folds into the shared magi_nft tables that wallets and explorers
// read) and this one (which lumen_ct_balances is built on, and which the
// wind-down keeper reads to find holders). A holder who acquired tokens on
// magi-market and appears in neither is a holder the keeper cannot sweep — so
// supply never reaches zero and the market can never close.
//
// from == "" is a graduation into the tradable bucket; to == "" is a burn out of
// it. Both are movements WITHIN one holder's position or out of supply, so a
// consumer must net them exactly as the standard views do.
func EvMaturedMoved(creator, actor, from, to string, block uint64, amount *big.Int) string {
	return evOpen("maturedMoved", creator, actor, block) +
		`,"from":"` + evJSONEscape(from) + `"` +
		`,"to":"` + evJSONEscape(to) + `"` +
		`,"amount":"` + evTokens(amount) + `"}`
}
