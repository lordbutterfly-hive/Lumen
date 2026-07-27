package core

import "math/big"

// setBandedPrice generalizes market.go's SetFace band into a reusable helper
// for a per-utility priced offer — the creator shop's per-offering prices
// (offerings.go) are the current caller — so a creator can price a service
// independently of the ask face, and a prepaid credit-holder is protected
// against a price spike on the action they hold credits to spend on, exactly
// as SetFace protects the ask.
//
// setBandedPrice below is a FAITHFUL GENERALIZATION of market.go's SetFace band,
// deliberately kept as a SEPARATE helper rather than refactoring SetFace, so the
// audited ask-price path (SetFace/Ask/quote) is left byte-for-byte untouched.
// The band logic is identical to SetFace's — anchor to a WINDOW, not to the last
// change; a fresh window after FaceBandWindow still re-bands against the current
// price (waiting out the window earns another 2x of headroom, never a free
// jump) — with ONE structural difference SetFace does not have:
//
//	SetFace always has a nonzero current price to band against, because face is
//	posted at Register (>= MinFace) and can never be unset. A per-utility price
//	is OPTIONAL and starts UNSET (0). The FIRST time a creator posts one there
//	is no prior price to measure a 2x band against, so any value in
//	[MinFace, MaxFace] is accepted and becomes the initial window anchor —
//	exactly as Register's own posting of the initial face opens face's first
//	window. Every SUBSEQUENT change is banded identically to a SetFace change.

// setBandedPrice sets a per-utility priced offer under the same 2x/7d band
// SetFace enforces on the ask face. priceKey/anchorKey/anchorAtKey/setAtKey are
// the four state keys for this offer (mirroring kFace/kFaceAnchor/
// kFaceAnchorAt/kFaceSetAt). Caller has already established creator authority
// and market-open via requireOpenCreatorMarket.
func setBandedPrice(s Store, creator string, block uint64, newPrice int64,
	priceKey, anchorKey, anchorAtKey, setAtKey string) error {
	if newPrice < MinFace || newPrice > MaxFace {
		return newErr(ErrInput, "price out of range [MinFace, MaxFace]")
	}

	cur := getMoney(s, priceKey)
	if cur.Sign() == 0 {
		// INITIAL POSTING: no prior price to band against. Accept any in-range
		// value and open the first window at it, exactly as Register opens
		// face's first window at the posted face (market.go: "the posted face
		// counts as the first 'set', starting the anti-rug clock immediately").
		setMoney(s, priceKey, big.NewInt(newPrice))
		setMoney(s, anchorKey, big.NewInt(newPrice))
		setU64(s, anchorAtKey, block)
		setU64(s, setAtKey, block)
		return nil
	}

	// SUBSEQUENT CHANGE: band against the window anchor — SetFace's exact logic.
	anchor := getMoney(s, anchorKey)
	anchorAt := getU64(s, anchorAtKey)
	if anchor.Sign() == 0 { // defensive: a posted price with no anchor opens a window at the current price
		anchor = cur
		anchorAt = getU64(s, setAtKey)
	}

	var elapsed uint64
	if block > anchorAt { // defensive: a non-monotone block keeps the band ACTIVE rather than lifting it
		elapsed = block - anchorAt
	}
	if elapsed >= FaceBandWindow {
		// Window expired: open a NEW one anchored at the price in effect now.
		// The band still applies against that fresh anchor (waiting out the
		// window earns another 2x, not a licence to jump anywhere) — the same
		// rule and the same reason as SetFace's identical branch.
		anchor = getMoney(s, priceKey)
		anchorAt = block
	}
	if anchor.Sign() > 0 {
		newBig := big.NewInt(newPrice)
		lower := new(big.Int).Div(anchor, big.NewInt(int64(FaceBandNumerator)))
		upper := new(big.Int).Mul(anchor, big.NewInt(int64(FaceBandNumerator)))
		if mLt(newBig, lower) || mGt(newBig, upper) {
			return newErr(ErrInput, "price change exceeds the 2x/7-day band (measured against the window anchor, not the last change)")
		}
	}
	setMoney(s, anchorKey, anchor)
	setU64(s, anchorAtKey, anchorAt)

	setMoney(s, priceKey, big.NewInt(newPrice))
	setU64(s, setAtKey, block)
	return nil
}
