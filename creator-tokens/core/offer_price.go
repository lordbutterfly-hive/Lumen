package core

import "math/big"

// Per-utility priced offers — SetUnlockPrice / SetSessionPrice and their reads
// (access-credit utility, 2026-07-21). Unlock and Session are OPTIONAL creator
// offers, each with its OWN posted HBD price and its OWN 2x/7d anti-rug band —
// so a creator can price a content unlock or a session independently of the ask
// face, and a prepaid credit-holder is protected against a price spike on the
// action they hold credits to spend on, exactly as SetFace protects the ask.
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
//	posted at Register (>= MinFace) and can never be unset. Unlock/session
//	prices are OPTIONAL and start UNSET (0). The FIRST time a creator posts one
//	there is no prior price to measure a 2x band against, so any value in
//	[MinFace, MaxFace] is accepted and becomes the initial window anchor —
//	exactly as Register's own posting of the initial face opens face's first
//	window. Every SUBSEQUENT change is banded identically to a SetFace change.
//
// Re-registration safety: Register clears kUnlockPrice/kSessionPrice, their
// band anchors AND their setAt blocks back to 0 (market.go, the same H4
// anti-rug reset the face anchor gets), so a returning creator re-posts a fresh
// price through the initial-posting branch below and can never be banded
// against a defunct incarnation's anchor. ★ This was a FALSE claim until
// 2026-07-21 — Register did not clear them, and the defect it describes was
// live; see keys.go's correction note.

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

// SetUnlockPrice posts (or changes, within the 2x/7d band) the creator's
// content-unlock price. Creator-only, market-must-exist, not-CLOSED — the same
// requireOpenCreatorMarket gate SetFace/SetCap use (a config change, not a fund
// flow, so deliberately NOT gated on OVERDUE/FROZEN or the global pause).
func SetUnlockPrice(s Store, caller, creator string, block uint64, newPrice int64) error {
	if err := requireOpenCreatorMarket(s, caller, creator); err != nil {
		return err
	}
	return setBandedPrice(s, creator, block, newPrice,
		kUnlockPrice(creator), kUnlockPriceAnchor(creator), kUnlockPriceAnchorAt(creator), kUnlockPriceSetAt(creator))
}

// SetSessionPrice posts (or changes, within the 2x/7d band) the creator's
// session price. Same authority/gating as SetUnlockPrice/SetFace.
func SetSessionPrice(s Store, caller, creator string, block uint64, newPrice int64) error {
	if err := requireOpenCreatorMarket(s, caller, creator); err != nil {
		return err
	}
	return setBandedPrice(s, creator, block, newPrice,
		kSessionPrice(creator), kSessionPriceAnchor(creator), kSessionPriceAnchorAt(creator), kSessionPriceSetAt(creator))
}

// UnlockPrice / SessionPrice — read accessors (0 == unset / not offered),
// exported for the wasm wrapper's owed-commission computation and quote preview,
// mirroring Face/Cap in read.go.
func UnlockPrice(s Store, creator string) *big.Int  { return getMoney(s, kUnlockPrice(creator)) }
func SessionPrice(s Store, creator string) *big.Int { return getMoney(s, kSessionPrice(creator)) }
