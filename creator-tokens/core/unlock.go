package core

import (
	"math/big"
	"strings"
)

// Unlock — spend-to-unlock of Lumen-hosted gated content (access-credit utility,
// 2026-07-21; Ruling 10 of DESIGN-HANDOFF).
//
// Unlike Ask/Book, Unlock is INSTANT and NON-ESCROWED: the content already
// exists, so there is no deliverable to escrow and reclaim-after-reading would
// be pure griefing (a buyer reads, then reclaims). So credits move buyer ->
// creator and the 12% HBD commission books to the treasury in this one call
// (delivered service, paid immediately — the same "book on delivery" point
// Answer books an ask's commission at, just with no waiting because delivery is
// instantaneous). The buyer receives a PERMANENT on-chain entitlement
// (kEntitlement), tied to the unlock EVENT and NOT to a live balance: selling or
// refunding every credit afterwards never revokes it (Ruling 10 — "yours to
// keep"). The gated body itself lives on Lumen and is served only to an entitled
// client; this contract stores only the entitlement flag and the postId.
//
// Manipulation defenses are Ask's, verbatim, because the money math is Ask's:
//   - the settlement rate is derived INTERNALLY (settleSpend, settlement.go —
//     min(TWAP_short, TWAP_long, spot) + the RULING C guards, REFUSING when no
//     safe rate exists; the old PAR fallback is deleted), never a caller
//     parameter, so §1.3b's defense can't be bypassed;
//   - creditsSpent is bounded by the buyer's own signed maxCredits, defending
//     the creator-controlled unlock-price-spike surface (SetUnlockPrice under
//     producer-chosen intra-block ordering) exactly as Ask's maxCredits defends
//     a face spike;
//   - commissionHbdPaid must EXACTLY equal commissionOwedFor(price) at execution
//     (the H2 exact-match shape), so a band-legal price move between signing and
//     execution can neither over- nor under-charge the HBD leg.
//
// Unlock is a NEW inflow -> gated on ACTIVE/OVERDUE via RequireInflowOpen
// (blocked FROZEN/CLOSED and under the global pause), exactly like Ask/Prepay:
// new unlocks stop when a market freezes, but an ALREADY-granted entitlement is
// never touched by any phase (it is a stored flag, read by the Lumen gate, with
// no outflow path this contract could ever block — the on-chain analog of
// "outflows never pause").
//
// I3 (supply == Σ balances + escrowed) is preserved: credits only MOVE from the
// buyer's balance to the creator's balance — none are minted or burned, and
// none enter escrow — so kSupply is untouched, identical to how Answer moves an
// escrow's credits to the creator without changing supply.
type UnlockResult struct {
	CreditsSpent  *big.Int
	CommissionHbd *big.Int
	RateUsed      *big.Int
}

func Unlock(s Store, caller, creator string, block uint64, postId string, maxCredits, commissionHbdPaid *big.Int) (*UnlockResult, error) {
	if !validAccount(caller) {
		return nil, newErr(ErrInput, "invalid caller")
	}
	if !validAccount(creator) {
		return nil, newErr(ErrInput, "invalid creator")
	}
	if postId == "" {
		return nil, newErr(ErrInput, "empty postId")
	}
	if strings.Contains(postId, "|") {
		return nil, newErr(ErrInput, "postId must not contain '|'")
	}
	if maxCredits == nil || !mGt(maxCredits, mZero()) {
		return nil, newErr(ErrInput, "maxCredits must be > 0")
	}
	if commissionHbdPaid == nil || commissionHbdPaid.Sign() < 0 {
		return nil, newErr(ErrInput, "invalid commission amount")
	}

	// New unlock is an inflow: gated ACTIVE/OVERDUE (this also rejects an
	// unlock against a market that does not exist — Phase reads a phantom market
	// as FROZEN, see market.go). Already-granted entitlements are never gated.
	if err := RequireInflowOpen(s, creator, block); err != nil {
		return nil, err
	}

	price := getMoney(s, kUnlockPrice(creator))
	if !mGt(price, mZero()) {
		return nil, newErr(ErrState, "creator does not offer unlocks")
	}

	// Idempotency: never charge twice for the same post. Reject a re-unlock so a
	// buyer who already holds the (permanent) entitlement can never be made to
	// pay again — the frontend renders already-granted content directly and
	// never re-opens this path, but a stale/racing client must fail closed.
	if IsEntitled(s, creator, caller, postId) {
		return nil, newErr(ErrState, "already unlocked")
	}

	// Settlement derivation + RULING C guards — the SAME settleSpend Ask and
	// Book use (RULING C3: Unlock does NOT get its own window; v1 priced it
	// off the long TWAP ALONE and that was backwards — longest = stalest =
	// highest rate = fewest tokens = LEAST creator-favouring: it sold a
	// PERMANENT, never-cleared 100 HBD entitlement for 12.111 HBD, repeatable
	// per gated post. Unlock's extra strictness now comes from the depth and
	// spend caps inside settleSpend, not from a staler rate). Refusal is a
	// typed revert on this new-service INFLOW; it gates no funds.
	q, err := settleSpend(s, creator, block, price)
	if err != nil {
		return nil, err
	}
	rate := q.Rate
	creditsSpent := q.Credits
	if mGt(creditsSpent, maxCredits) {
		return nil, newErr(ErrInput, "creditsSpent exceeds maxCredits")
	}
	if owed := commissionOwedFor(price); commissionHbdPaid.Cmp(owed) != 0 {
		return nil, newErr(ErrBalance, "commission must exactly equal commissionOwedFor(price) at execution (not more, not less)")
	}

	bal := getMoney(s, kBal(creator, caller))
	if mLt(bal, creditsSpent) {
		return nil, newErr(ErrBalance, "insufficient credits")
	}
	// Chokepoint debit + credit (holdclock.go): the buyer spends their
	// tokens, and the creator's leg re-averages their clock toward `block`
	// (service-earned tokens are exit-taxed as fresh — "reset on ANY inflow",
	// zero exceptions). The buyer's clock is NOT touched: spending does not
	// re-age a remainder. RULING K deleted the cost basis, so neither leg
	// carries one now.
	if err := debitBalance(s, creator, caller, creditsSpent); err != nil {
		return nil, err // unreachable given the check above; defense-in-depth
	}
	creditInflow(s, creator, creator, creditsSpent, block) // credits to creator (instant, delivered)
	addMoney(s, kTreasury(), commissionHbdPaid)                     // 12% HBD booked on delivery (instant)
	setStr(s, kEntitlement(creator, caller, postId), "1")

	return &UnlockResult{CreditsSpent: creditsSpent, CommissionHbd: commissionHbdPaid, RateUsed: rate}, nil
}

// IsEntitled reports whether `buyer` has permanently unlocked `postId` on
// `creator`'s market. Read by the Lumen SSR gate to authorize serving a gated
// body, and by Unlock itself for the never-charge-twice guard. Permanent: no
// path in this contract ever clears an entitlement.
func IsEntitled(s Store, creator, buyer, postId string) bool {
	return getStr(s, kEntitlement(creator, buyer, postId)) == "1"
}
