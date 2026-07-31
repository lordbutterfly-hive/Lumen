package core

import "math/big"

// matured.go — the MATURED bucket: the half of a holder's position that has
// cleared the exit-tax window and is therefore (a) worth exactly the same as
// every other matured token of that creator, and (b) safe to let leave.
//
// WHY TWO BUCKETS AT ALL. A token still inside the window owes tax that depends
// on its own age, so two such tokens are not the same good and cannot be traded
// as one. Past ExitTaxDecayBlocks the rate is 0 for everyone (exittax.go's
// ExitTaxBpsAt returns exactly 0 at and past the window), so every matured token
// of a creator is interchangeable. That — and only that — is what makes them
// listable as a fungible edition.
//
// The rule this file enforces: MATURING TOKENS NEVER LEAVE. They can be sold
// back to the curve at their own rate, and nothing else. Matured tokens may move
// freely. So no token that owes tax can reach a counterparty, and no token that
// can reach a counterparty owes tax.
//
// ★ THE STORAGE HERE IS NOT OURS. It is magi_nft's, byte for byte, because
// magi-market does not call our ABI to read a balance — it reads the raw state
// key (magi-market/contract/internal.go:951-969). So this bucket is written in
// their layout and their codec or the market cannot see it:
//
//	bal|<holder>|<creator>            little-endian uint64, high zero bytes trimmed
//	allow|<owner>|<spender>|<creator> same codec (M2)
//
// Note the TRANSPOSE: their key is (account, tokenId) where ours has always been
// (creator, holder). With creator ≡ tokenId that is the same two names in the
// opposite order, which is exactly why the maturing family had to vacate the
// "bal|" prefix (keys.go).
//
// ★ THE u64 CARVE-OUT, stated so it is never widened by accident. exittax.go's
// package rule is "no uint64 arithmetic anywhere near money math, with zero
// exceptions to reason about". This file is the exception and it is safe BY
// SCOPE, not by luck: the u64 family carries TOKEN COUNTS only, never HBD. A
// count is bounded by supply, supply by MaxCap = 1e9, and 1e9 encodes in four
// bytes against a uint64 ceiling of ~1.8e19 — ten orders of magnitude of head
// room. Every arithmetic operation below is still done in big.Int; u64 appears
// only at the encode/decode boundary. HBD must never reach these helpers.

// kMatured is the market-facing matured-balance key. Argument order is
// (holder, creator) — TRANSPOSED relative to kBal — because that is the order
// magi-market builds when it reads us. Getting this backwards silently aliases
// one holder's position onto another's, so the argument names are deliberately
// not interchangeable.
func kMatured(holder, c string) string { return "bal|" + holder + "|" + c }

// u64ToLE encodes n in magi_nft's exact wire form: little-endian uint64 with
// trailing (high-order) zero bytes trimmed. Zero encodes as a single 0x00 byte —
// but zero is never STORED, because setMatured deletes the key instead, which is
// also what magi_nft does. Reproducing both halves matters: a key holding an
// 8-byte 0x0100000000000000 decodes correctly yet differs from their bytes, and
// any conformance check that compares against their encoder would catch it.
func u64ToLE(n uint64) []byte {
	b := make([]byte, 8)
	for i := 0; i < 8; i++ {
		b[i] = byte(n >> (8 * i))
	}
	last := 0
	for i := 7; i >= 0; i-- {
		if b[i] != 0 {
			last = i
			break
		}
	}
	return b[:last+1]
}

// leToU64 decodes the above. Left-aligned copy into a zeroed 8-byte buffer, so a
// short value is a small number, exactly as magi_nft and magi-market both do.
//
// A value longer than 8 bytes is NOT decodable and is a defect on our side, not
// theirs: magi-market ABORTS on it (internal.go:848-859), and an abort inside a
// wasm export traps and reverts the whole transaction — so one over-long value
// under this key family would brick every market read against that holder. It
// is unreachable through correct arithmetic (1e9 needs four bytes) and is
// pinned by test rather than tolerated at runtime.
func leToU64(b []byte) (uint64, bool) {
	if len(b) > 8 {
		return 0, false
	}
	var n uint64
	for i := 0; i < len(b); i++ {
		n |= uint64(b[i]) << (8 * i)
	}
	return n, true
}

// getMatured reads the matured balance as a big.Int. An absent, empty or
// malformed value reads as zero — the same convention every other read in this
// package uses, and the treasury-favouring direction.
func getMatured(s Store, c, h string) *big.Int {
	v, ok := s.Get(kMatured(h, c))
	if !ok || v == "" {
		return mZero()
	}
	n, valid := leToU64([]byte(v))
	if !valid {
		return mZero()
	}
	return new(big.Int).SetUint64(n)
}

// setMatured writes the matured balance, deleting the key at zero exactly as
// magi_nft does (its setBalance/setAllowance both delete rather than store a
// zero). Panics on a value that cannot be a token count — negative, or past the
// supply ceiling — because either means an arithmetic bug upstream and storing
// it would put a value on-chain that aborts the market's decoder.
func setMatured(s Store, c, h string, v *big.Int) {
	if v.Sign() < 0 {
		panic("setMatured: negative token count for " + c + "/" + h)
	}
	if !v.IsUint64() || v.Uint64() > uint64(MaxCap) {
		panic("setMatured: token count exceeds MaxCap for " + c + "/" + h)
	}
	key := kMatured(h, c)
	if v.Sign() == 0 {
		s.Delete(key)
		return
	}
	s.Set(key, string(u64ToLE(v.Uint64())))
}

// maturedNow reports whether (c,h)'s MATURING balance has cleared the window as
// of `block`. Pure read — it never writes, so it is safe to call from inside a
// guard, before the call is known to succeed.
//
// heldBlocksAt saturates at 0 below and CAPS at ExitTaxDecayBlocks above, so the
// capped value equals the window exactly when the real holding time has reached
// it. An unset clock reads as 0 (maximally fresh), so a never-clocked balance is
// never treated as matured.
func maturedNow(s Store, c, h string, block uint64) bool {
	if getMoney(s, kBal(c, h)).Sign() == 0 {
		return false
	}
	return heldBlocksAt(s, c, h, block) >= ExitTaxDecayBlocks
}

// totalBalance is the holder's whole position: maturing + matured. EVERY guard
// that used to read kBal alone must read this instead, or a holder is refused
// access to tokens they demonstrably own — which is how refund.go's "no state
// leaves a holder trapped" proof breaks.
func totalBalance(s Store, c, h string) *big.Int {
	return mAdd(getMoney(s, kBal(c, h)), getMatured(s, c, h))
}

// splitDraw apportions a withdrawal of `amount` across the two buckets:
// MATURING FIRST, then matured. Pure read — computes the split without moving
// anything, so a caller can price the exit before deciding whether to allow it.
//
// ★★ THE ORDER IS MATURING-FIRST, AND IT IS LOAD-BEARING (2026-07-30, changed
// after scrutiny measured the alternative at up to 99.98% tax avoidance).
//
// The intuitive order is matured-first: a matured token owes zero whether it
// sells now or in ten years, so consuming it first "costs the protocol nothing".
// That reasoning is true per token and WRONG in aggregate, because the curve
// prices by position, not by token. Matured-first lets a seller split one exit
// into two:
//
//	chunk 1 — exactly the matured balance. Taxable share zero, correctly, and it
//	          consumes the DEAREST slice at the top of the curve.
//	chunk 2 — the still-maturing tokens, now priced against a supply the first
//	          chunk already lowered, i.e. the CHEAPEST slice.
//
// Gross is identical either way (the curve telescopes exactly), so only the
// taxable base moves — and it moves to the cheap end. Measured: 32.8% avoided on
// a balanced position, 99.98% on 100,000 matured against 100 fresh. That is
// precisely the ET-1 class RULING K1 exists to forbid: the anti-chunking
// guarantee rests on the tax being superadditive across chunks, which holds only
// while the BASE cannot be re-priced by choosing where to cut.
//
// Maturing-first inverts it. Any chunk containing taxed tokens now prices them
// at the TOP of the curve, so every split pays strictly MORE than the single
// sale, and the single sale is optimal again. The seller keeps the same total
// gross and the protocol keeps the tax it is owed.
//
// It also stops a curve sell from silently draining the MATURED bucket — the
// one magi-market can see, and the one a live listing and any outstanding
// allowance are backed by.
//
// The caller MUST have already proven totalBalance >= amount; this function
// clamps rather than erroring, so an unchecked call would silently under-draw.
func splitDraw(s Store, c, h string, amount *big.Int) (fromMatured, fromMaturing *big.Int) {
	maturing := getMoney(s, kBal(c, h))
	if amount.Cmp(maturing) <= 0 {
		return mZero(), new(big.Int).Set(amount)
	}
	rest, err := mSub(amount, maturing)
	if err != nil {
		return mZero(), new(big.Int).Set(amount) // unreachable: amount > maturing
	}
	return rest, new(big.Int).Set(maturing)
}

// maturingGrossShare apportions gross proceeds to the MATURING part of a draw,
// pro rata by token count and rounded UP.
//
// ★ THIS IS THE FIX FOR A MEASURED DEFECT (money-math scrutiny, 2026-07-30).
// The obvious implementation — let the matured tokens take the first, dearest
// price slice off the top of the curve and tax only what is left — is the exact
// TAX-MINIMISING pairing: it matches the cheapest rate to the dearest tokens.
// Measured at −39% of collections on the canonical position, and up to −88% on a
// skewed one. Pro rata is the neutral apportionment: it reproduces the same
// total tax the blended clock charges today, and it removes bucket ordering as
// an economic lever entirely.
//
// Ceil keeps the residue in the more-tax direction, consistent with every other
// rounding decision on this path (RULING F).
func maturingGrossShare(gross, fromMaturing, total *big.Int) *big.Int {
	if fromMaturing.Sign() == 0 || gross.Sign() == 0 || total.Sign() == 0 {
		return mZero()
	}
	if fromMaturing.Cmp(total) == 0 {
		return new(big.Int).Set(gross)
	}
	return mMulDivCeil(gross, fromMaturing, total)
}

// escrowAcqBlock is the single hold-clock an escrow records for a draw that may
// span both buckets.
//
// The escrow record carries ONE acquisition block (ask.go's escrowRec), so a
// mixed draw has to collapse to one number. The matured portion is represented
// by maturityFloorBlock(block) — the oldest age that still counts, i.e. exactly
// one full window — so a purely-matured escrow returns to its owner still
// matured, with no special case and no new field. A mixed escrow collapses to
// the size-weighted average of the two clocks, which is EXACTLY tax-neutral
// because the rate is affine in age across the capped window (holdclock.go's
// proof); it neither refunds tax the asker owed nor charges tax they did not.
//
// Rounded UP — a higher block is a YOUNGER clock, which is the more-tax
// direction, consistent with every other rounding decision on this path.
func escrowAcqBlock(s Store, c, h string, block uint64, fromMatured, fromMaturing *big.Int) uint64 {
	floor := maturityFloorBlock(block)
	if fromMaturing.Sign() == 0 {
		return floor
	}
	wacq := holderAcqBlock(s, c, h)
	if fromMatured.Sign() == 0 {
		return wacq
	}
	// weighted mean of {floor × fromMatured, wacq × fromMaturing}, ceil.
	num := mAdd(
		new(big.Int).Mul(new(big.Int).SetUint64(floor), fromMatured),
		new(big.Int).Mul(new(big.Int).SetUint64(wacq), fromMaturing),
	)
	den := mAdd(fromMatured, fromMaturing)
	mean := mMulDivCeil(num, big.NewInt(1), den)
	if !mean.IsUint64() {
		return wacq // unreachable: a mean of two block heights is a block height
	}
	return mean.Uint64()
}

// debitPosition removes `amount` from the holder's position, MATURING first
// (see splitDraw — the order is what makes the exit tax un-splittable).
// Infallible once totalBalance >= amount has been proven; it returns an error
// only on that broken precondition, and it writes NOTHING on that path.
func debitPosition(s Store, c, h string, amount *big.Int) error {
	if mLt(totalBalance(s, c, h), amount) {
		return newErr(ErrBalance, "insufficient credits")
	}
	fromMatured, fromMaturing := splitDraw(s, c, h, amount)
	if fromMaturing.Sign() > 0 {
		if err := debitBalance(s, c, h, fromMaturing); err != nil {
			return err // unreachable: the total guard covers it
		}
	}
	if fromMatured.Sign() > 0 {
		cur := getMatured(s, c, h)
		next, err := mSub(cur, fromMatured)
		if err != nil {
			return err // unreachable: splitDraw clamps to the matured balance
		}
		setMatured(s, c, h, next)
	}
	return nil
}

// graduate moves a holder's whole maturing balance into the matured bucket when
// it has cleared the window, and reports how much moved.
//
// ALL-OR-NOTHING, deliberately. The hold clock is one weighted average over the
// holder's maturing balance, so there is no per-token age to graduate a slice
// against; the whole balance clears together when the average does. Per-token
// graduation was scoped and cut (BUILD-MAP §"what was cut") — this shape keeps
// the clock semantics that are already property-tested, and the two-bucket split
// does most of what per-token was for, because matured tokens leave the average
// instead of dragging fresh ones down forever.
//
// INFALLIBLE and ORDER-SAFE. It only ever runs after its caller's guards have
// passed, and it cannot itself fail: the balance is read, moved, and the clock
// cleared. Callers must NOT call it before a guard that can still reject, or
// they reintroduce the mutate-then-reject shape RULING G exists to forbid.
// Graduate is the exported, standalone form: a holder moving their own cleared
// position into the tradable bucket without having to buy or sell anything.
//
// It exists because every other trigger is a side effect of some other action —
// Buy, Sell, Refund — and a holder who simply bought once and waited would
// otherwise have no way in at all. Worse, those triggers close exactly when the
// market does: once inflows shut (retired, frozen, delinquent) a Buy is refused,
// so the last rail into the matured bucket would shut with them.
//
// Returns how much moved; zero is a no-op, not an error, so a client may call it
// unconditionally before listing.
func Graduate(s Store, creator, holder string, block uint64) *big.Int {
	if !validAccount(creator) || !validAccount(holder) {
		return mZero()
	}
	return graduate(s, creator, holder, block)
}

func graduate(s Store, c, h string, block uint64) *big.Int {
	if !maturedNow(s, c, h, block) {
		return mZero()
	}
	n := getMoney(s, kBal(c, h))
	// DELETE rather than store "0". A zero left behind is not wrong to read, but
	// it leaves a dead key on the most-written family for every graduation, and
	// it keeps the holder visible to prefix scans that look for maturing
	// positions — which is how a graduated holder ends up listed with a balance
	// of nothing. setMatured deletes at zero for the same reason.
	s.Delete(kBal(c, h))
	s.Delete(kAcqBlock(c, h))
	setMatured(s, c, h, mAdd(getMatured(s, c, h), n))
	return n
}
